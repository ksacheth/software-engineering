import { prisma, type NetworkBlocklistType, type Prisma } from "@wvs/database";
import {
  parseBlocklistPattern,
  type BlocklistEntry,
  type BlocklistPatternProblem,
} from "@wvs/scope-rules";
import type { AuthContext } from "../../common/session";
import { writeAudit } from "../../common/audit";

/**
 * F.8 network blocklist, administration side.
 *
 * Entries are validated and canonicalised by the same parser the matcher uses
 * (ADR-0005), so anything stored here is something the Scope Guard can
 * evaluate. A pattern is never edited in place: changing what an entry blocks
 * is a different entry, and the audit log should say so.
 */

type Reader = Pick<Prisma.TransactionClient, "networkBlocklist">;

/** The entries in force, in the shape `@wvs/scope-rules` matches against. */
export async function activeBlocklist(
  client: Reader = prisma,
): Promise<BlocklistEntry[]> {
  return client.networkBlocklist.findMany({
    where: { isActive: true },
    select: { id: true, patternType: true, pattern: true },
    orderBy: { createdAt: "asc" },
  });
}

const entryInclude = {
  createdBy: { select: { id: true, email: true, name: true } },
} as const;

export async function listBlocklist() {
  return prisma.networkBlocklist.findMany({
    include: entryInclude,
    orderBy: { createdAt: "desc" },
  });
}

export type BlocklistWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "NOT_FOUND" }
  | { ok: false; kind: "INVALID"; problem: BlocklistPatternProblem };

export async function createBlocklistEntry(
  ctx: AuthContext,
  input: { patternType: string; pattern: string; reason: string },
): Promise<BlocklistWriteResult<Awaited<ReturnType<typeof listBlocklist>>[number]>> {
  const parsed = parseBlocklistPattern(input.patternType, input.pattern);
  if (!parsed.ok) return { ok: false, kind: "INVALID", problem: parsed.problem };

  const entry = await prisma.networkBlocklist.create({
    data: {
      patternType: parsed.patternType as NetworkBlocklistType,
      pattern: parsed.pattern,
      reason: input.reason,
      createdById: ctx.userId,
    },
    include: entryInclude,
  });

  await writeAudit(ctx, {
    action: "ADMIN_BLOCKLIST_CREATED",
    resourceType: "network_blocklist",
    resourceId: entry.id,
    organizationId: null,
    metadata: {
      patternType: entry.patternType,
      pattern: entry.pattern,
      reason: entry.reason,
    },
  });
  return { ok: true, value: entry };
}

export async function updateBlocklistEntry(
  ctx: AuthContext,
  id: string,
  changes: { isActive?: boolean; reason?: string },
): Promise<BlocklistWriteResult<Awaited<ReturnType<typeof listBlocklist>>[number]>> {
  const before = await prisma.networkBlocklist.findUnique({ where: { id } });
  if (!before) return { ok: false, kind: "NOT_FOUND" };

  const entry = await prisma.networkBlocklist.update({
    where: { id },
    data: changes,
    include: entryInclude,
  });

  await writeAudit(ctx, {
    action: "ADMIN_BLOCKLIST_UPDATED",
    resourceType: "network_blocklist",
    resourceId: id,
    organizationId: null,
    metadata: {
      pattern: entry.pattern,
      before: { isActive: before.isActive, reason: before.reason },
      after: { isActive: entry.isActive, reason: entry.reason },
    },
  });
  return { ok: true, value: entry };
}

export async function deleteBlocklistEntry(
  ctx: AuthContext,
  id: string,
): Promise<BlocklistWriteResult<null>> {
  const deleted = await prisma.networkBlocklist
    .delete({ where: { id } })
    .catch(() => null);
  if (!deleted) return { ok: false, kind: "NOT_FOUND" };

  // The row is gone, so the audit record is the only place left that says what
  // the entry blocked.
  await writeAudit(ctx, {
    action: "ADMIN_BLOCKLIST_DELETED",
    resourceType: "network_blocklist",
    resourceId: id,
    organizationId: null,
    metadata: {
      patternType: deleted.patternType,
      pattern: deleted.pattern,
      reason: deleted.reason,
      isActive: deleted.isActive,
    },
  });
  return { ok: true, value: null };
}
