import { prisma } from "@wvs/database";
import {
  QUOTA_OCCUPYING_SCAN_STATUSES,
  type OrganizationQuota,
} from "@wvs/shared";
import type { AuthContext } from "../../common/session";
import { writeAudit } from "../../common/audit";

/**
 * F.8 quota administration.
 *
 * F.3 enforces these when a scan is requested (`reserveScan`). Changing one
 * never touches a scan already running: lowering a limit refuses new scans, it
 * does not cancel work someone started under the old one.
 */

export interface OrganizationSummary extends OrganizationQuota {
  id: string;
  name: string;
  slug: string | null;
  createdAt: Date;
  memberCount: number;
  activeScans: number;
}

export async function listOrganizations(): Promise<OrganizationSummary[]> {
  const [organizations, active] = await Promise.all([
    prisma.organization.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        maxConcurrentScans: true,
        scanRateLimit: true,
        _count: { select: { members: true } },
      },
    }),
    prisma.scanJob.groupBy({
      by: ["organizationId"],
      where: { status: { in: [...QUOTA_OCCUPYING_SCAN_STATUSES] } },
      _count: { _all: true },
    }),
  ]);

  const activeByOrg = new Map(
    active.map((row) => [row.organizationId, row._count._all]),
  );
  return organizations.map(({ _count, ...organization }) => ({
    ...organization,
    memberCount: _count.members,
    activeScans: activeByOrg.get(organization.id) ?? 0,
  }));
}

export async function readQuota(
  organizationId: string,
): Promise<OrganizationQuota | null> {
  return prisma.organization.findUnique({
    where: { id: organizationId },
    select: { maxConcurrentScans: true, scanRateLimit: true },
  });
}

export async function changeQuota(
  ctx: AuthContext,
  organizationId: string,
  changes: Partial<OrganizationQuota>,
): Promise<OrganizationQuota | null> {
  const before = await readQuota(organizationId);
  if (!before) return null;

  const after = await prisma.organization.update({
    where: { id: organizationId },
    data: changes,
    select: { maxConcurrentScans: true, scanRateLimit: true },
  });

  await writeAudit(ctx, {
    action: "ADMIN_QUOTA_CHANGED",
    resourceType: "organization",
    resourceId: organizationId,
    organizationId,
    metadata: { before, after },
  });
  return after;
}
