import { MockDetector, type MockCrawlRecord, type RawFinding } from "../detectors/mock-detector.js";
import { Deduplicator } from "../processors/deduplicator.js";
import { AdvisoryEnricher } from "../enrichers/advisory-enricher.js";
import { TriageCarrier } from "../processors/triage-carrier.js";
import {
  type ScanJobPayload,
  type ScanEvent,
} from "@wvs/shared";

export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number | void>;
}

export interface OrchestratorOptions {
  prisma: any;
  redis?: RedisPublisher;
  detector?: (records: MockCrawlRecord[]) => RawFinding[] | Promise<RawFinding[]>;
  enricher?: AdvisoryEnricher;
}

export class ScanOrchestrator {
  private prisma: any;
  private redis?: RedisPublisher;
  private detectFn: (records: MockCrawlRecord[]) => RawFinding[] | Promise<RawFinding[]>;
  private enricher: AdvisoryEnricher;

  constructor(options: OrchestratorOptions) {
    this.prisma = options.prisma;
    this.redis = options.redis;
    this.detectFn = options.detector || MockDetector.analyze;
    this.enricher = options.enricher || new AdvisoryEnricher();
  }

  private async emitEvent(event: ScanEvent): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.publish("wvs:scan-events", JSON.stringify(event));
      } catch (err) {
        console.error("[Orchestrator] Failed to publish event:", err);
      }
    }
  }

  async processScanJob(payload: ScanJobPayload): Promise<void> {
    const { scanJobId } = payload;

    const scanJob = await this.prisma.scanJob.findUnique({
      where: { id: scanJobId },
      include: { target: true },
    });

    if (!scanJob) {
      throw new Error(`ScanJob with ID ${scanJobId} not found`);
    }

    if (["COMPLETED", "FAILED", "CANCELLED", "ABORTED_SAFETY"].includes(scanJob.status)) {
      console.log(`[Orchestrator] ScanJob ${scanJobId} is already in terminal status: ${scanJob.status}`);
      return;
    }

    try {
      // Step 1: Transition to RUNNING / DISCOVERY
      await this.prisma.scanJob.update({
        where: { id: scanJobId },
        data: {
          status: "RUNNING",
          phase: "DISCOVERY",
          startedAt: new Date(),
          progressPercentage: 10.0,
        },
      });

      await this.emitEvent({
        type: "scan.status",
        scanJobId,
        status: "RUNNING",
        phase: "DISCOVERY",
        at: new Date().toISOString(),
      });

      await this.emitEvent({
        type: "scan.progress",
        scanJobId,
        phase: "DISCOVERY",
        pagesCrawled: 0,
        requestsMade: 0,
        findingsCount: 0,
        progressPercentage: 10.0,
        at: new Date().toISOString(),
      });

      // Step 2: Crawling Phase
      let pages = await this.prisma.crawledPage.findMany({
        where: { scanJobId },
      });

      if (pages.length === 0) {
        const origin = scanJob.target?.origin || "https://target.local";
        const sampleUrls = [
          `${origin}/`,
          `${origin}/login?id=1`,
          `${origin}/search?q=test`,
        ];

        for (const url of sampleUrls) {
          await this.prisma.crawledPage.create({
            data: {
              scanJobId,
              url,
              normalizedUrl: url,
              method: "GET",
              statusCode: 200,
              contentType: "text/html",
              responseHeaders: { "Content-Type": "text/html" },
              requestHeaders: { "User-Agent": "WVS-Scanner/1.0" },
            },
          });
        }

        pages = await this.prisma.crawledPage.findMany({
          where: { scanJobId },
        });
      }

      const pagesCrawled = pages.length;
      const requestsMade = pagesCrawled * 2;

      await this.prisma.scanJob.update({
        where: { id: scanJobId },
        data: {
          phase: "DETECTION",
          pagesCrawled,
          requestsMade,
          progressPercentage: 40.0,
        },
      });

      await this.emitEvent({
        type: "scan.progress",
        scanJobId,
        phase: "DETECTION",
        pagesCrawled,
        requestsMade,
        findingsCount: 0,
        progressPercentage: 40.0,
        at: new Date().toISOString(),
      });

      // Step 3: Run Vulnerability Detection
      const crawlRecords: MockCrawlRecord[] = pages.map((p: any) => ({
        url: p.url,
        method: p.method,
        statusCode: p.statusCode,
        contentType: p.contentType || undefined,
        requestHeaders: p.requestHeaders ? (p.requestHeaders as Record<string, string>) : undefined,
        responseHeaders: p.responseHeaders ? (p.responseHeaders as Record<string, string>) : undefined,
      }));

      const rawFindings = await Promise.resolve(this.detectFn(crawlRecords));

      // Step 4: Deduplicate Findings (F.6)
      const dedupedFindings = Deduplicator.deduplicate(rawFindings);

      // Step 5: Enrich Findings with Threat Intelligence (F.5 OSV/EPSS)
      const enrichedFindings = await this.enricher.enrichFindings(dedupedFindings);

      // Step 6: Triage & Historical Scan Comparison (F.6 Triage Carry-Forward)
      let priorTriageRecords: any[] = [];
      let previousScanFingerprints: string[] = [];

      try {
        if (this.prisma.targetFindingTriage?.findMany) {
          priorTriageRecords = await this.prisma.targetFindingTriage.findMany({
            where: { targetId: scanJob.targetId },
          });
        }

        const prevScan = await this.prisma.scanJob.findFirst({
          where: {
            targetId: scanJob.targetId,
            status: "COMPLETED",
            id: { not: scanJobId },
          },
          orderBy: { completedAt: "desc" },
        });

        if (prevScan) {
          const prevFindings = await this.prisma.finding.findMany({
            where: { scanJobId: prevScan.id },
            select: { fingerprint: true },
          });
          previousScanFingerprints = prevFindings.map((f: any) => f.fingerprint);
        }
      } catch (err) {
        console.warn("[Orchestrator] Warning: could not fetch prior triage/scan history:", err);
      }

      const currentFingerprints = enrichedFindings.map((f: any) => f.fingerprint);
      const triageResult = TriageCarrier.processScanTriage(
        scanJob.targetId,
        scanJobId,
        currentFingerprints,
        priorTriageRecords,
        previousScanFingerprints
      );

      // Step 7: Persist Processed Findings & Diff Records
      let createdFindingsCount = 0;
      for (const ef of enrichedFindings as any[]) {
        const existingFinding = await this.prisma.finding.findFirst({
          where: { scanJobId, fingerprint: ef.fingerprint },
        });

        if (!existingFinding) {
          const finding = await this.prisma.finding.create({
            data: {
              scanJobId,
              targetId: scanJob.targetId,
              fingerprint: ef.fingerprint,
              detectorId: ef.detectorId,
              name: ef.name,
              description: ef.description,
              remediation: ef.remediation,
              severity: ef.severity,
              confidence: ef.confidence,
              cwe: ef.cwe || null,
              owaspCategory: ef.owaspCategory || null,
              affectedUrl: ef.affectedUrl,
              affectedParameter: ef.affectedParameter || null,
              cvssScore: ef.cvssScore || null,
              cvssVector: ef.cvssVector || null,
              cveId: ef.cveId || null,
              epssScore: ef.epssScore || null,
              epssPercentile: ef.epssPercentile || null,
              advisoryData: ef.advisoryData || null,
              occurrenceCount: ef.occurrenceCount || 1,
              occurrences: ef.occurrences || null,
              evidence: ef.evidence
                ? {
                    create: {
                      requestHeaders: ef.evidence.requestHeaders || undefined,
                      requestBody: ef.evidence.requestBody || undefined,
                      responseHeaders: ef.evidence.responseHeaders || undefined,
                      responseBody: ef.evidence.responseBody || undefined,
                      curlCommand: ef.evidence.curlCommand || undefined,
                      extractedSnippet: ef.evidence.extractedSnippet || undefined,
                      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
                    },
                  }
                : undefined,
            },
          });

          createdFindingsCount++;

          await this.emitEvent({
            type: "scan.finding",
            scanJobId,
            fingerprint: finding.fingerprint,
            detectorId: finding.detectorId,
            name: finding.name,
            severity: finding.severity as any,
            affectedUrl: finding.affectedUrl,
            at: new Date().toISOString(),
          });
        }
      }

      // Persist diff records if DB supports scanFindingDiff
      if (this.prisma.scanFindingDiff?.createMany) {
        try {
          await this.prisma.scanFindingDiff.createMany({
            data: triageResult.diffRecords,
          });
        } catch (err) {
          console.warn("[Orchestrator] Could not persist scan finding diffs:", err);
        }
      }

      // Step 8: Mark COMPLETED
      await this.prisma.scanJob.update({
        where: { id: scanJobId },
        data: {
          status: "COMPLETED",
          phase: "COMPLETED",
          completedAt: new Date(),
          progressPercentage: 100.0,
          findingsCount: createdFindingsCount,
        },
      });

      await this.emitEvent({
        type: "scan.status",
        scanJobId,
        status: "COMPLETED",
        phase: "COMPLETED",
        at: new Date().toISOString(),
      });

      await this.emitEvent({
        type: "scan.progress",
        scanJobId,
        phase: "COMPLETED",
        pagesCrawled,
        requestsMade,
        findingsCount: createdFindingsCount,
        progressPercentage: 100.0,
        at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error(`[Orchestrator] ScanJob ${scanJobId} failed:`, err);
      const failureReason = err?.message || String(err);

      await this.prisma.scanJob.update({
        where: { id: scanJobId },
        data: {
          status: "FAILED",
          failureReason,
        },
      });

      await this.emitEvent({
        type: "scan.status",
        scanJobId,
        status: "FAILED",
        failureReason,
        at: new Date().toISOString(),
      });

      throw err;
    }
  }
}
