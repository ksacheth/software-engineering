import { prisma } from "@wvs/database";
import { isScannable } from "@wvs/scope-rules";
import {
  SCAN_STATUSES,
  type FindingSeverity,
  type ScanStatus,
} from "@wvs/shared";
import type { AuthContext } from "../../common/session";
import { countPostureBySeverity } from "../findings/finding-queries";
import { activeBlocklist } from "../scope-guard/blocklist";

/**
 * The dashboard's overview: counts only, each taken by the rule the page it
 * summarises already applies, so a number here never disagrees with the list
 * one click away. Targets are counted as the Targets page lists them (archived
 * ones left out), and findings as the Findings page shows them unfiltered.
 */
export interface DashboardSummaryDto {
  targets: { total: number; scannable: number };
  scans: Record<ScanStatus, number>;
  findings: Record<FindingSeverity, number>;
}

export async function dashboardSummary(
  ctx: AuthContext,
): Promise<DashboardSummaryDto> {
  const { organizationId } = ctx;
  const [targets, blocklist, scanGroups, findings] = await Promise.all([
    prisma.target.findMany({ where: { organizationId, isArchived: false } }),
    activeBlocklist(),
    prisma.scanJob.groupBy({
      by: ["status"],
      where: { organizationId },
      _count: { _all: true },
    }),
    countPostureBySeverity(ctx),
  ]);

  const scans = Object.fromEntries(
    SCAN_STATUSES.map((status) => [status, 0]),
  ) as Record<ScanStatus, number>;
  for (const group of scanGroups) scans[group.status] = group._count._all;

  return {
    targets: {
      total: targets.length,
      scannable: targets.filter(
        (target) => isScannable(target, blocklist).scannable,
      ).length,
    },
    scans,
    findings,
  };
}
