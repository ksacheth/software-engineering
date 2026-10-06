import type { CrawledPage, Prisma, PrismaClient, ScanJob, Target } from "@wvs/database";
import type { ScanEvent, ScanJobPayload, ScanProgressEvent, ScanWarningCode } from "@wvs/shared";
import { isKillSwitchEngaged, KILL_SWITCH_SETTING_KEY } from "@wvs/shared";
import type { MockCrawlRecord, RawFinding } from "../detectors/mock-detector.js";
import { Deduplicator, type DeduplicatedFinding } from "../processors/deduplicator.js";
import { AdvisoryEnricher } from "../enrichers/advisory-enricher.js";
import { TriageCarrier, type ScanFindingDiffRecord } from "../processors/triage-carrier.js";

export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number | void>;
}

export type Detector = (records: MockCrawlRecord[]) => RawFinding[] | Promise<RawFinding[]>;

/** What the engine reports about a run. */
export interface EngineOutcome {
  findings: RawFinding[];
  pagesCrawled: number;
  requestsMade: number;
  /**
   * Set when the engine stopped early because the kill switch tripped or the
   * scan was paused or cancelled. The findings are then partial and unused.
   */
  aborted?: "KILL_SWITCH" | "STOPPED" | null;
  /** Degradations worth telling the user about, published as scan.warning events. */
  warnings?: Array<{ code: ScanWarningCode; message: string }>;
}

/** The real engine: crawls and detects in one step, returning findings and counts.
 *  When supplied it replaces the mock detector and the read-from-DB crawl step. */
export type ScanEngine = (scanJob: ScanJob & { target: Target }) => Promise<EngineOutcome>;

export interface OrchestratorOptions {
  prisma: PrismaClient;
  redis?: RedisPublisher;
  /**
   * Required, with no default: the mock detector reports findings that do not
   * exist, so the worker entry point has to choose it by name (see README).
   */
  detector: Detector;
  engine?: ScanEngine;
  enricher?: AdvisoryEnricher;
}

/** Evidence retention (F.6 evidence purge default). */
const EVIDENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Progress reported on entering each phase. */
const PROGRESS_BY_PHASE: Record<ScanProgressEvent["phase"], number> = {
  DISCOVERY: 10.0,
  DETECTION: 40.0,
  REPORTING: 90.0,
  COMPLETED: 100.0,
};

/** Interactive transactions default to 5 s, too short for a large finding set. */
const PERSIST_TIMEOUT_MS = 60_000;

interface DiscoveryResult {
  pagesCrawled: number;
  requestsMade: number;
  detect: () => Promise<RawFinding[]>;
  aborted: EngineOutcome["aborted"];
  warnings: NonNullable<EngineOutcome["warnings"]>;
}

/** Thrown inside the persistence transaction to roll it back when the scan was paused or cancelled. */
class ScanNoLongerRunning extends Error {}

export class ScanOrchestrator {
  private prisma: PrismaClient;
  private redis?: RedisPublisher;
  private detectFn: Detector;
  private engine?: ScanEngine;
  private enricher: AdvisoryEnricher;

  constructor(options: OrchestratorOptions) {
    this.prisma = options.prisma;
    this.redis = options.redis;
    this.detectFn = options.detector;
    this.engine = options.engine;
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

  private async emitProgress(
    scanJobId: string,
    phase: ScanProgressEvent["phase"],
    counts: Pick<ScanProgressEvent, "pagesCrawled" | "requestsMade" | "findingsCount">
  ): Promise<void> {
    await this.emitEvent({
      type: "scan.progress",
      scanJobId,
      phase,
      ...counts,
      progressPercentage: PROGRESS_BY_PHASE[phase],
      at: new Date().toISOString(),
    });
  }

  async processScanJob(payload: ScanJobPayload): Promise<void> {
    const { scanJobId } = payload;

    const scanJob = await this.prisma.scanJob.findUnique({
      where: { id: scanJobId },
    });

    if (!scanJob) {
      throw new Error(`ScanJob with ID ${scanJobId} not found`);
    }

    // Step 1: Claim the scan (ADR-0007). Only a QUEUED scan, or a RUNNING one
    // resumed for exactly this attempt, may start. A paused, cancelled or
    // finished scan, or a job left over from an earlier attempt, is skipped.
    const claimed = await this.prisma.scanJob.updateMany({
      where: {
        id: scanJobId,
        attempt: payload.attempt,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      data: {
        status: "RUNNING",
        phase: "DISCOVERY",
        startedAt: scanJob.startedAt ?? new Date(),
        progressPercentage: PROGRESS_BY_PHASE.DISCOVERY,
      },
    });

    if (claimed.count === 0) {
      console.log(
        `[Orchestrator] Skipping ScanJob ${scanJobId}: status ${scanJob.status}, attempt ${scanJob.attempt} (job attempt ${payload.attempt})`
      );
      return;
    }

    try {
      await this.runPipeline(scanJobId, scanJob.targetId);
    } catch (err) {
      console.error(`[Orchestrator] ScanJob ${scanJobId} failed:`, err);
      await this.markFailed(scanJobId, err);
      throw err;
    }
  }

  private async runPipeline(scanJobId: string, targetId: string): Promise<void> {
    await this.emitEvent({
      type: "scan.status",
      scanJobId,
      status: "RUNNING",
      phase: "DISCOVERY",
      at: new Date().toISOString(),
    });

    await this.emitProgress(scanJobId, "DISCOVERY", { pagesCrawled: 0, requestsMade: 0, findingsCount: 0 });

    // Step 2: Discovery. The engine crawls the live target; without one, the mock
    // path reads whatever pages are already in the database.
    const discovery = await this.discover(scanJobId);
    await this.emitWarnings(scanJobId, discovery.warnings);

    // An engine that was stopped midway is neither complete nor failed. A pause,
    // cancel or kill switch already moved the row (ADR-0007, ADR-0008), so the
    // scan is left as that flow set it and nothing is persisted.
    if (discovery.aborted) {
      console.log(`[Orchestrator] ScanJob ${scanJobId} stopped by ${discovery.aborted}; not completing it.`);
      // The engine's kill-switch read fails closed, so a database blip also
      // looks like the switch. Nothing else moves the row then (the job is not
      // retried and the reconciler only handles QUEUED), so fail it here.
      if (discovery.aborted === "KILL_SWITCH" && !(await this.killSwitchConfirmed())) {
        await this.markFailed(scanJobId, new Error("Scan stopped because the kill switch could not be read"));
      }
      return;
    }

    const stillRunning = await this.updateWhileRunning(scanJobId, {
      phase: "DETECTION",
      pagesCrawled: discovery.pagesCrawled,
      requestsMade: discovery.requestsMade,
      progressPercentage: PROGRESS_BY_PHASE.DETECTION,
    });
    if (!stillRunning) return;

    await this.emitProgress(scanJobId, "DETECTION", {
      pagesCrawled: discovery.pagesCrawled,
      requestsMade: discovery.requestsMade,
      findingsCount: 0,
    });

    // Step 3: Detection. The mock path runs its detector here; the engine has
    // already detected, and watched for pause and cancel itself, while it ran.
    const rawFindings = await discovery.detect();
    const { pagesCrawled, requestsMade } = discovery;

    // Step 4: Deduplicate Findings (F.6)
    const dedupedFindings = Deduplicator.deduplicate(rawFindings);

    // Step 5: Enrich Findings with Threat Intelligence (F.5 OSV/EPSS)
    const enrichedFindings = await this.enricher.enrichFindings(dedupedFindings);

    // Step 6: Compare against the previous scan (F.6 diff status). Triage state
    // needs no write here: it is held per (target, fingerprint), so earlier
    // decisions already apply to these findings, and a fingerprint nobody has
    // triaged is OPEN (ADR-0003).
    const previousScanFingerprints = await this.previousScanFingerprints(targetId, scanJobId);
    const { diffRecords } = TriageCarrier.processScanTriage(
      targetId,
      scanJobId,
      enrichedFindings.map((f) => f.fingerprint),
      [],
      previousScanFingerprints
    );

    // Step 7: Persist findings, diffs and completion together
    const persisted = await this.persistResults(scanJobId, targetId, enrichedFindings, diffRecords);
    if (!persisted) return;

    for (const finding of persisted) {
      await this.emitEvent({
        type: "scan.finding",
        scanJobId,
        fingerprint: finding.fingerprint,
        detectorId: finding.detectorId,
        name: finding.name,
        severity: finding.severity,
        affectedUrl: finding.affectedUrl,
        at: new Date().toISOString(),
      });
    }

    await this.emitEvent({
      type: "scan.status",
      scanJobId,
      status: "COMPLETED",
      phase: "COMPLETED",
      at: new Date().toISOString(),
    });

    await this.emitProgress(scanJobId, "COMPLETED", {
      pagesCrawled,
      requestsMade,
      findingsCount: persisted.length,
    });
  }

  /**
   * Discovery, returning the crawl counts and a `detect` thunk. The engine
   * crawls and detects together (checking for pause and cancel as it goes), so
   * its findings are simply held in the thunk; the mock path reads the pages
   * now and defers the detector call until after the checkpoint.
   */
  private async discover(scanJobId: string): Promise<DiscoveryResult> {
    if (this.engine) {
      const scanJob = await this.prisma.scanJob.findUnique({ where: { id: scanJobId }, include: { target: true } });
      if (!scanJob) throw new Error(`ScanJob ${scanJobId} vanished mid-scan`);
      const result = await this.engine(scanJob);
      return {
        pagesCrawled: result.pagesCrawled,
        requestsMade: result.requestsMade,
        detect: async () => result.findings,
        aborted: result.aborted ?? null,
        warnings: result.warnings ?? [],
      };
    }

    const pages = await this.prisma.crawledPage.findMany({ where: { scanJobId } });
    return {
      pagesCrawled: pages.length,
      requestsMade: pages.length * 2,
      detect: () => Promise.resolve(this.detectFn(pages.map(toCrawlRecord))),
      aborted: null,
      warnings: [],
    };
  }

  private async emitWarnings(scanJobId: string, warnings: NonNullable<EngineOutcome["warnings"]>): Promise<void> {
    for (const { code, message } of warnings) {
      await this.emitEvent({ type: "scan.warning", scanJobId, code, message, at: new Date().toISOString() });
    }
  }

  /**
   * Applies a progress update only while the scan is still RUNNING, which is
   * also the checkpoint where a pause or cancel is noticed (ADR-0007).
   */
  private async updateWhileRunning(
    scanJobId: string,
    data: Prisma.ScanJobUpdateManyMutationInput
  ): Promise<boolean> {
    const updated = await this.prisma.scanJob.updateMany({
      where: { id: scanJobId, status: "RUNNING" },
      data,
    });
    if (updated.count === 0) {
      console.log(`[Orchestrator] ScanJob ${scanJobId} is no longer RUNNING; stopping.`);
      return false;
    }
    return true;
  }

  private async previousScanFingerprints(targetId: string, scanJobId: string): Promise<string[]> {
    const prevScan = await this.prisma.scanJob.findFirst({
      where: {
        targetId,
        status: "COMPLETED",
        id: { not: scanJobId },
      },
      orderBy: { completedAt: "desc" },
    });

    if (!prevScan) return [];

    const prevFindings = await this.prisma.finding.findMany({
      where: { scanJobId: prevScan.id },
      select: { fingerprint: true },
    });
    return prevFindings.map((f) => f.fingerprint);
  }

  /**
   * All or nothing: a crash or error leaves no partial findings, so the next
   * delivery of the job starts clean, and a committed scan is COMPLETED and is
   * never claimed again. Returns null when the scan was paused or cancelled
   * before it could complete, in which case nothing is written.
   */
  private async persistResults(
    scanJobId: string,
    targetId: string,
    findings: DeduplicatedFinding[],
    diffRecords: ScanFindingDiffRecord[]
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const completed = await tx.scanJob.updateMany({
            where: { id: scanJobId, status: "RUNNING" },
            data: {
              status: "COMPLETED",
              phase: "COMPLETED",
              completedAt: new Date(),
              progressPercentage: PROGRESS_BY_PHASE.COMPLETED,
              findingsCount: findings.length,
            },
          });
          if (completed.count === 0) throw new ScanNoLongerRunning();

          const created = [];
          for (const finding of findings) {
            created.push(
              await tx.finding.create({ data: toFindingData(scanJobId, targetId, finding) })
            );
          }

          await tx.scanFindingDiff.createMany({ data: diffRecords });
          return created;
        },
        { timeout: PERSIST_TIMEOUT_MS }
      );
    } catch (err) {
      if (err instanceof ScanNoLongerRunning) {
        console.log(`[Orchestrator] ScanJob ${scanJobId} was stopped before completion; discarding results.`);
        return null;
      }
      throw err;
    }
  }

  /** True only when the kill-switch row is readable and engaged. */
  private async killSwitchConfirmed(): Promise<boolean> {
    try {
      const setting = await this.prisma.systemSetting.findUnique({ where: { key: KILL_SWITCH_SETTING_KEY } });
      return isKillSwitchEngaged(setting?.value);
    } catch {
      return false;
    }
  }

  /** Marks the scan FAILED unless a pause or cancel already took it out of RUNNING. */
  private async markFailed(scanJobId: string, err: unknown): Promise<void> {
    const failureReason = err instanceof Error ? err.message : String(err);

    const failed = await this.prisma.scanJob.updateMany({
      where: { id: scanJobId, status: "RUNNING" },
      data: {
        status: "FAILED",
        failureReason,
      },
    });
    if (failed.count === 0) return;

    await this.emitEvent({
      type: "scan.status",
      scanJobId,
      status: "FAILED",
      failureReason,
      at: new Date().toISOString(),
    });
  }
}

function toCrawlRecord(page: CrawledPage): MockCrawlRecord {
  return {
    url: page.url,
    method: page.method,
    statusCode: page.statusCode,
    contentType: page.contentType ?? undefined,
    requestHeaders: (page.requestHeaders as Record<string, string> | null) ?? undefined,
    responseHeaders: (page.responseHeaders as Record<string, string> | null) ?? undefined,
  };
}

function toFindingData(
  scanJobId: string,
  targetId: string,
  finding: DeduplicatedFinding
): Prisma.FindingUncheckedCreateInput {
  const evidence = finding.evidence;
  return {
    scanJobId,
    targetId,
    fingerprint: finding.fingerprint,
    detectorId: finding.detectorId,
    name: finding.name,
    description: finding.description,
    remediation: finding.remediation,
    severity: finding.severity,
    confidence: finding.confidence,
    cwe: finding.cwe ?? null,
    owaspCategory: finding.owaspCategory ?? null,
    affectedUrl: finding.affectedUrl,
    affectedParameter: finding.affectedParameter ?? null,
    cvssScore: finding.cvssScore ?? null,
    cvssVector: finding.cvssVector ?? null,
    cveId: finding.cveId ?? null,
    epssScore: finding.epssScore ?? null,
    epssPercentile: finding.epssPercentile ?? null,
    advisoryData: finding.advisoryData ?? undefined,
    occurrenceCount: finding.occurrenceCount,
    occurrences: finding.occurrences as Prisma.InputJsonValue,
    evidence: evidence
      ? {
          create: {
            requestHeaders: evidence.requestHeaders ?? undefined,
            requestBody: evidence.requestBody ?? undefined,
            responseHeaders: evidence.responseHeaders ?? undefined,
            responseBody: evidence.responseBody ?? undefined,
            curlCommand: evidence.curlCommand ?? undefined,
            extractedSnippet: evidence.extractedSnippet ?? undefined,
            expiresAt: new Date(Date.now() + EVIDENCE_TTL_MS),
          },
        }
      : undefined,
  };
}
