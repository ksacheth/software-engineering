import { prisma } from "@wvs/database";
import type { ScanJob, Target } from "@wvs/database";
import type { BlocklistEntry } from "@wvs/scope-guard";
import type { ScanProfile } from "@wvs/shared";
import { isKillSwitchEngaged, KILL_SWITCH_SETTING_KEY } from "@wvs/shared";
import { loadDefinitions, type DetectorCatalogue } from "@wvs/detectors";

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
 * True once the scan row is no longer RUNNING (paused, cancelled or aborted),
 * read at most every STATUS_POLL_MS. A failed read keeps the scan going: the
 * kill switch, not this, is the fail-closed control.
 */
function stopReader(scanJobId: string): () => Promise<boolean> {
  let stopped = false;
  let lastRead = 0;
  return async () => {
    if (stopped || Date.now() - lastRead < STATUS_POLL_MS) return stopped;
    lastRead = Date.now();
    try {
      const row = await prisma.scanJob.findUnique({ where: { id: scanJobId }, select: { status: true } });
      stopped = row?.status !== "RUNNING";
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

/** What an earlier run of this scan already spent, so a resumed or redelivered job keeps one budget. */
async function loadResume(scanJobId: string): Promise<NonNullable<EngineInput["resumeFrom"]>> {
  const [requestsMade, pages] = await Promise.all([
    // Refusals never reached the target; ERROR rows did (or tried to).
    prisma.urlLedger.count({ where: { scanJobId, decision: { in: ["ALLOWED", "ERROR"] } } }),
    prisma.crawledPage.findMany({ where: { scanJobId }, select: { normalizedUrl: true } }),
  ]);
  const seenUrls = [...new Set(pages.map((page) => page.normalizedUrl))];
  return { requestsMade, pagesCrawled: pages.length, seenUrls };
}

/** Builds the orchestrator engine: loads the catalogue once, then crawls and
 *  detects each scan against its target's scope snapshot. */
export async function createScanEngine(): Promise<OrchestratorEngine> {
  const catalogue: DetectorCatalogue = await loadDefinitions();

  const launchRenderer = renderJsEnabled() ? launchPlaywrightRenderer : undefined;

  return async (scanJob: ScanJob & { target: Target }) => {
    const [adminBlocklist, resumeFrom] = await Promise.all([loadBlocklist(), loadResume(scanJob.id)]);
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
        shouldStop: stopReader(scanJob.id),
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
