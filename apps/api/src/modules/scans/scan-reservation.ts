import { Prisma, prisma, type ScanJob } from "@wvs/database";
import {
  QUOTA_OCCUPYING_SCAN_STATUSES,
  type ScanConfiguration,
  type ScanProfile,
} from "@wvs/shared";

/**
 * F.3 quota enforcement.
 *
 * Concurrency is counted from the database rather than a Redis counter,
 * because database state cannot drift from reality when a worker dies
 * mid-scan. The count and the insert happen in one serializable transaction,
 * retrying on serialization failure, so simultaneous requests cannot both pass
 * the limit. Scan initiation is not a hot path, so correctness is worth more
 * than throughput.
 */

const ACTIVE_STATUSES = [...QUOTA_OCCUPYING_SCAN_STATUSES];
const MAX_SERIALIZATION_RETRIES = 3;

export type ScanReservation =
  | { ok: true; scan: ScanJob }
  | { ok: false; kind: "TARGET_NOT_FOUND" }
  | { ok: false; kind: "ORG_CONCURRENCY"; limit: number }
  | { ok: false; kind: "TARGET_ALREADY_ACTIVE"; scanJobId: string };

export interface ReserveScanInput {
  organizationId: string;
  targetId: string;
  profile: ScanProfile;
  configuration: ScanConfiguration;
  createdById: string;
}

function isSerializationFailure(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  );
}

/**
 * Claim a concurrency slot and write the QUEUED row in one atomic step.
 *
 * The scope snapshot is copied from the target inside the transaction: a scan
 * runs with the scope that was in force when it was requested, which is what
 * F.2/F.3 reproducibility requires, even if the scope is edited a moment
 * later.
 */
export async function reserveScan(
  input: ReserveScanInput,
): Promise<ScanReservation> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const organization = await tx.organization.findUnique({
            where: { id: input.organizationId },
            select: { maxConcurrentScans: true },
          });
          const limit = organization?.maxConcurrentScans ?? 2;

          const activeCount = await tx.scanJob.count({
            where: {
              organizationId: input.organizationId,
              status: { in: ACTIVE_STATUSES },
            },
          });
          if (activeCount >= limit) {
            return { ok: false, kind: "ORG_CONCURRENCY", limit } as const;
          }

          const target = await tx.target.findUnique({
            where: { id: input.targetId },
            select: {
              id: true,
              organizationId: true,
              includedPaths: true,
              excludedPaths: true,
            },
          });
          if (!target || target.organizationId !== input.organizationId) {
            return { ok: false, kind: "TARGET_NOT_FOUND" } as const;
          }

          // A second scan of the same target would be two crawls against one
          // host, which the operator of that host experiences as an attack.
          const activeForTarget = await tx.scanJob.findFirst({
            where: {
              organizationId: input.organizationId,
              targetId: input.targetId,
              status: { in: ACTIVE_STATUSES },
            },
            select: { id: true },
            orderBy: { createdAt: "desc" },
          });
          if (activeForTarget) {
            return {
              ok: false,
              kind: "TARGET_ALREADY_ACTIVE",
              scanJobId: activeForTarget.id,
            } as const;
          }

          const scan = await tx.scanJob.create({
            data: {
              targetId: input.targetId,
              organizationId: input.organizationId,
              profile: input.profile,
              status: "QUEUED",
              phase: "DISCOVERY",
              createdById: input.createdById,
              rateLimit: input.configuration.rateLimit,
              concurrency: input.configuration.concurrency,
              maxDepth: input.configuration.maxDepth,
              maxPages: input.configuration.maxPages,
              maxRequests: input.configuration.maxRequests,
              includedPaths: target.includedPaths,
              excludedPaths: target.excludedPaths,
            },
          });

          return { ok: true, scan } as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationFailure(error) && attempt < MAX_SERIALIZATION_RETRIES) {
        continue;
      }
      throw error;
    }
  }
}
