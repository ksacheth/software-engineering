import { prisma } from "@wvs/database";
import { QUOTA_OCCUPYING_SCAN_STATUSES } from "@wvs/shared";
import { isScanningHalted } from "../scope-guard/kill-switch";
import { pingScanQueue, scanQueueCounts } from "../scans/scan-queue";

/**
 * F.8 health view for administrators (a "should").
 *
 * The public `/api/health` stays a bare liveness probe for containers. This is
 * the version that answers "why are scans not moving": whether the stores are
 * reachable, what the queue holds, what is running, and whether scanning has
 * been halted. Each probe reports its own failure rather than failing the
 * whole response, since a partial answer is what an operator needs most when
 * something is down.
 */

async function probe<T>(work: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await work();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readHealth() {
  const [database, redis, queue, scans, killSwitch, email] = await Promise.all([
    probe(async () => {
      await prisma.systemSetting.count();
      return { ok: true as const };
    }),
    probe(async () => {
      await pingScanQueue();
      return { ok: true as const };
    }),
    probe(scanQueueCounts),
    probe(async () => {
      const rows = await prisma.scanJob.groupBy({
        by: ["status"],
        where: { status: { in: [...QUOTA_OCCUPYING_SCAN_STATUSES] } },
        _count: { _all: true },
      });
      const counts: Record<string, number> = Object.fromEntries(
        QUOTA_OCCUPYING_SCAN_STATUSES.map((status) => [status, 0]),
      );
      for (const row of rows) counts[row.status] = row._count._all;
      return counts;
    }),
    probe(async () => ({ engaged: await isScanningHalted() })),
    probe(async () => {
      const [pending, oldest, deadLettered] = await Promise.all([
        prisma.emailOutbox.count({ where: { status: "FAILED" } }),
        prisma.emailOutbox.findFirst({
          where: { status: "FAILED" },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
        prisma.emailOutbox.count({ where: { status: "DEAD_LETTER" } }),
      ]);
      return {
        pending,
        deadLettered,
        oldestPendingAt: oldest?.createdAt ?? null,
      };
    }),
  ]);

  return { database, redis, queue, scans, killSwitch, email };
}
