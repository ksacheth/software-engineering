import { Prisma, prisma } from "@wvs/database";
import type { ScanJob, Target } from "@wvs/database";
import type { BlocklistEntry } from "@wvs/scope-guard";
import type { ScanProfile } from "@wvs/shared";
import { isKillSwitchEngaged, KILL_SWITCH_SETTING_KEY } from "@wvs/shared";
import { detectorVersions, loadDefinitions, type DetectorCatalogue } from "@wvs/detectors";

import { renderJsEnabled, scannerUserAgent } from "../config.js";
import { launchPlaywrightRenderer } from "../crawler/playwright-renderer.js";
import { runScanEngine, type EngineInput, type EngineResult } from "./scan-engine.js";
import type { ScanEngine as OrchestratorEngine } from "../orchestrator/scan-orchestrator.js";

/** Reads the kill switch fresh, and fails closed if the row cannot be read (ADR-0008). */
async function killSwitchReader(): Promise<boolean> {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: KILL_SWITCH_SETTING_KEY } });
    return isKillSwitchEngaged(setting?.value);
  } catch {
    return true;
  }
}

/** How often a running scan re-reads its status row; ADR-0007 asks for a checkpoint about every 2 s. */
const STATUS_POLL_MS = 2_000;

/**
 * True once the scan row is no longer RUNNING for this attempt (paused,
 * cancelled, aborted, or resumed as a newer attempt that another worker now
 * runs), read at most every STATUS_POLL_MS. A failed read keeps the scan
 * going: the kill switch, not this, is the fail-closed control.
 */
function stopReader(scanJobId: string, attempt: number): () => Promise<boolean> {
  let stopped = false;
  let lastRead = 0;
  return async () => {
    if (stopped || Date.now() - lastRead < STATUS_POLL_MS) return stopped;
    lastRead = Date.now();
    try {
      const row = await prisma.scanJob.findUnique({ where: { id: scanJobId }, select: { status: true, attempt: true } });
      stopped = row?.status !== "RUNNING" || row.attempt !== attempt;
    } catch (error) {
      console.warn(`[Engine] Scan ${scanJobId}: could not read its status, continuing:`, error);
    }
    return stopped;
  };
}

/** Active rows, read fresh for every scan so an administrator's change applies to the next one. */
function loadBlocklist(): Promise<BlocklistEntry[]> {
  return prisma.networkBlocklist.findMany({
    where: { isActive: true },
    select: { id: true, pattern: true, patternType: true },
  });
}

/**
 * The requests an earlier run of this scan already sent, so a resumed or
 * redelivered job keeps one request budget. Pages are crawled again rather
 * than marked seen: response bodies are not stored, so a page skipped here
 * would never reach the detectors and the scan would finish with no findings
 * for it. Re-crawled pages upsert their existing crawled_page rows.
 */
async function loadResume(scanJobId: string): Promise<NonNullable<EngineInput["resumeFrom"]>> {
  const requestsMade = await prisma.urlLedger.count({
    where: {
      scanJobId,
      // Refusals never left the worker. ERROR rows count only when a request
      // was attempted (it has a response time); a DNS failure is also ERROR.
      OR: [{ decision: "ALLOWED" }, { decision: "ERROR", responseTimeMs: { not: null } }],
    },
  });
  return { requestsMade, pagesCrawled: 0, seenUrls: [] };
}

/**
 * Records which detector versions the scan runs (FR-3.12). Written once: a scan
 * resumed after a worker upgrade keeps the versions it started with.
 */
async function recordDetectorVersions(scanJob: ScanJob, catalogue: DetectorCatalogue): Promise<void> {
  await prisma.scanJob.updateMany({
    where: { id: scanJob.id, detectorVersions: { equals: Prisma.DbNull } },
    data: { detectorVersions: detectorVersions(catalogue, scanJob.profile as ScanProfile) },
  });
}

/** Builds the orchestrator engine: loads the catalogue once, then crawls and
 *  detects each scan against its target's scope snapshot. */
export async function createScanEngine(): Promise<OrchestratorEngine> {
  const catalogue: DetectorCatalogue = await loadDefinitions();

  const launchRenderer = renderJsEnabled() ? launchPlaywrightRenderer : undefined;

  return async (scanJob: ScanJob & { target: Target }) => {
    const [adminBlocklist, resumeFrom] = await Promise.all([
      loadBlocklist(),
      loadResume(scanJob.id),
      recordDetectorVersions(scanJob, catalogue),
    ]);
    const result = await runScanEngine(
      prisma,
      {
        scanJobId: scanJob.id,
        profile: scanJob.profile as ScanProfile,
        scope: {
          origin: scanJob.target.origin,
          includedPaths: scanJob.includedPaths,
          excludedPaths: scanJob.excludedPaths,
          verifiedIpSet: scanJob.target.verifiedIpRanges,
          rateLimit: scanJob.rateLimit,
          maxPages: scanJob.maxPages,
          maxRequests: scanJob.maxRequests,
          maxDepth: scanJob.maxDepth,
        },
        adminBlocklist,
        isKillSwitchEngaged: killSwitchReader,
        shouldStop: stopReader(scanJob.id, scanJob.attempt),
        resumeFrom,
        launchRenderer,
        userAgent: scannerUserAgent(),
      },
      catalogue,
    );
    reportGaps(scanJob.id, result);
    return {
      findings: result.findings,
      pagesCrawled: result.pagesCrawled,
      requestsMade: result.requestsMade,
      aborted: result.aborted,
      warnings: result.warnings,
    };
  };
}

/** Detector failures and refused probes mean coverage the scan did not get; there is no warning code for them yet, so they are logged. */
function reportGaps(scanJobId: string, result: EngineResult): void {
  for (const failure of result.failures) {
    console.warn(`[Engine] Scan ${scanJobId}: detector ${failure.detectorId} failed on ${failure.affectedUrl}: ${failure.message}`);
  }
  if (result.probesRefused > 0) {
    console.warn(`[Engine] Scan ${scanJobId}: the guard refused ${result.probesRefused} active probes; that coverage is missing.`);
  }
}
