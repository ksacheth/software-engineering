import { MockDetector, type MockCrawlRecord, type RawFinding } from "../detectors/mock-detector.js";
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
}

export class ScanOrchestrator {
  private prisma: any;
  private redis?: RedisPublisher;
  private detectFn: (records: MockCrawlRecord[]) => RawFinding[] | Promise<RawFinding[]>;

  constructor(options: OrchestratorOptions) {
    this.prisma = options.prisma;
    this.redis = options.redis;
    this.detectFn = options.detector || MockDetector.analyze;
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
    const now = new Date().toISOString();

    const scanJob = await this.prisma.scanJob.findUnique({
      where: { id: scanJobId },
      include: { target: true },
    });

    if (!scanJob) {
      throw new Error(`ScanJob with ID ${scanJobId} not found`);
    }

    // Check if job is already in terminal state
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

      // Step 2: Crawling phase (Fetch existing or populate crawl records)
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

      // Step 4: Persist Findings
      let createdFindingsCount = 0;
      for (const rf of rawFindings) {
        const param = rf.affectedParameter || "global";
        const fingerprint = `${rf.detectorId}|${rf.affectedUrl}|${param}`;

        const existingFinding = await this.prisma.finding.findFirst({
          where: { scanJobId, fingerprint },
        });

        if (!existingFinding) {
          const finding = await this.prisma.finding.create({
            data: {
              scanJobId,
              targetId: scanJob.targetId,
              fingerprint,
              detectorId: rf.detectorId,
              name: rf.name,
              description: rf.description,
              remediation: rf.remediation,
              severity: rf.severity,
              confidence: rf.confidence,
              cwe: rf.cwe || null,
              owaspCategory: rf.owaspCategory || null,
              affectedUrl: rf.affectedUrl,
              affectedParameter: rf.affectedParameter || null,
              cvssScore: rf.cvssScore || null,
              cvssVector: rf.cvssVector || null,
              cveId: rf.cveId || null,
              epssScore: rf.epssScore || null,
              epssPercentile: rf.epssPercentile || null,
              evidence: rf.evidence
                ? {
                    create: {
                      requestHeaders: rf.evidence.requestHeaders || undefined,
                      requestBody: rf.evidence.requestBody || undefined,
                      responseHeaders: rf.evidence.responseHeaders || undefined,
                      responseBody: rf.evidence.responseBody || undefined,
                      curlCommand: rf.evidence.curlCommand || undefined,
                      extractedSnippet: rf.evidence.extractedSnippet || undefined,
                      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days retention
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

      // Step 5: Mark COMPLETED
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
