import { prisma, type AuditAction, type Prisma } from "@wvs/database";

/**
 * F.8 audit review (a "should").
 *
 * Paged by (timestamp, id), newest first, which the `timestamp` and
 * `(organizationId, timestamp)` indexes serve. Records carry scalar user and
 * organisation ids with no foreign keys (ADR-0002), so names are looked up
 * separately and a record whose user is gone still reads, with `user: null`.
 */

export const MAX_AUDIT_PAGE_SIZE = 100;
const DEFAULT_AUDIT_PAGE_SIZE = 50;

export interface AuditQuery {
  action?: AuditAction;
  organizationId?: string;
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

interface Cursor {
  timestamp: Date;
  id: string;
}

export function encodeAuditCursor(cursor: Cursor): string {
  return Buffer.from(
    `${cursor.timestamp.toISOString()}|${cursor.id}`,
  ).toString("base64url");
}

export function decodeAuditCursor(value: string): Cursor | null {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const [iso, id] = decoded.split("|");
  const timestamp = new Date(iso ?? "");
  if (!id || Number.isNaN(timestamp.getTime())) return null;
  return { timestamp, id };
}

/**
 * Attach who and which organisation to each record. A record whose user or
 * organisation has been deleted keeps its id and gets null here.
 */
async function withNames<T extends { userId: string | null; organizationId: string | null }>(
  rows: T[],
) {
  const idsOf = (key: "userId" | "organizationId") => [
    ...new Set(rows.flatMap((row) => (row[key] ? [row[key]] : []))),
  ];
  const [users, organizations] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: idsOf("userId") } },
      select: { id: true, email: true, name: true },
    }),
    prisma.organization.findMany({
      where: { id: { in: idsOf("organizationId") } },
      select: { id: true, name: true },
    }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const orgById = new Map(organizations.map((o) => [o.id, o]));

  return rows.map((row) => ({
    ...row,
    user: (row.userId && userById.get(row.userId)) || null,
    organization: (row.organizationId && orgById.get(row.organizationId)) || null,
  }));
}

export async function listAudit(query: AuditQuery) {
  const limit = query.limit ?? DEFAULT_AUDIT_PAGE_SIZE;
  const cursor = query.cursor ? decodeAuditCursor(query.cursor) : null;

  const where: Prisma.AuditLogWhereInput = {
    action: query.action,
    organizationId: query.organizationId,
    userId: query.userId,
    resourceType: query.resourceType,
    resourceId: query.resourceId,
    timestamp:
      query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
    ...(cursor
      ? {
          OR: [
            { timestamp: { lt: cursor.timestamp } },
            { timestamp: cursor.timestamp, id: { lt: cursor.id } },
          ],
        }
      : {}),
  };

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);

  const last = page.at(-1);
  return {
    entries: await withNames(page),
    nextCursor:
      rows.length > limit && last
        ? encodeAuditCursor({ timestamp: last.timestamp, id: last.id })
        : null,
  };
}
