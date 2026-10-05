import { prisma } from "@wvs/database";
import type { ScanJob, Target } from "@wvs/database";
import type { ScanProfile } from "@wvs/shared";
import { isKillSwitchEngaged, KILL_SWITCH_SETTING_KEY } from "@wvs/shared";
import { loadDefinitions, type DetectorCatalogue } from "@wvs/detectors";

import { scannerUserAgent } from "../config.js";
import { runScanEngine } from "./scan-engine.js";
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

/** Builds the orchestrator engine: loads the catalogue once, then crawls and
 *  detects each scan against its target's scope snapshot. */
export async function createScanEngine(): Promise<OrchestratorEngine> {
  const catalogue: DetectorCatalogue = await loadDefinitions();

  return async (scanJob: ScanJob & { target: Target }) => {
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
        adminBlocklist: [],
        isKillSwitchEngaged: killSwitchReader,
        userAgent: scannerUserAgent(),
      },
      catalogue,
    );
    return { findings: result.findings, pagesCrawled: result.pagesCrawled, requestsMade: result.requestsMade };
  };
}
