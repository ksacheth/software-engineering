import { prisma, type Prisma, type Role } from "@wvs/database";
import type { AuthContext } from "../../common/session";
import {
  writeAudit,
  writeSystemAudit,
  type AuditEntry,
} from "../../common/audit";

/**
 * F.8 account administration (ADR-0009).
 *
 * Every change an administrator makes to an account is refused when the
 * account is their own. That single rule is also what keeps at least one
 * administrator in the deployment: whoever is acting is one, and they cannot
 * demote or suspend themselves, so no sequence of these calls can remove the
 * last one.
 */

export const MAX_USER_PAGE_SIZE = 100;
const DEFAULT_USER_PAGE_SIZE = 50;

const userSelect = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  role: true,
  twoFactorEnabled: true,
  suspendedAt: true,
  lockedUntil: true,
  createdAt: true,
  members: { select: { organization: { select: { id: true, name: true } } } },
  sessions: {
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 1,
  },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

function toUserDto({ members, sessions, twoFactorEnabled, ...user }: UserRow) {
  return {
    ...user,
    twoFactorEnabled: twoFactorEnabled === true,
    organization: members[0]?.organization ?? null,
    // The newest live session. Sessions expire and sign-out deletes them, so
    // an account with none has not signed in recently rather than never.
    lastSignInAt: sessions[0]?.createdAt ?? null,
  };
}

export type UserDto = ReturnType<typeof toUserDto>;

export interface ListUsersOptions {
  q?: string;
  limit?: number;
  cursor?: string;
}

export async function listUsers(options: ListUsersOptions) {
  const limit = options.limit ?? DEFAULT_USER_PAGE_SIZE;
  const q = options.q?.trim();

  const rows = await prisma.user.findMany({
    where: q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    select: userSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, limit);
  return {
    users: page.map(toUserDto),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export type AccountChangeResult =
  | { ok: true; user: UserDto }
  | { ok: false; kind: "NOT_FOUND" | "CANNOT_CHANGE_SELF" | "NO_CHANGE" };

async function findUser(id: string): Promise<UserRow | null> {
  return prisma.user.findUnique({ where: { id }, select: userSelect });
}

function organizationOf(user: UserRow): string | null {
  return user.members[0]?.organization.id ?? null;
}

/**
 * The shape every account change shares: never to yourself, never to an
 * account that does not exist, a no-op reported as such, and one audit record
 * in the account's own organisation for each change that happened.
 */
async function changeAccount(
  ctx: AuthContext,
  userId: string,
  change: {
    /** Apply the change; false when the account was already in that state. */
    apply: (before: UserRow) => Promise<boolean>;
    audit: (before: UserRow) => Pick<AuditEntry, "action" | "metadata">;
  },
): Promise<AccountChangeResult> {
  if (userId === ctx.userId) return { ok: false, kind: "CANNOT_CHANGE_SELF" };
  const before = await findUser(userId);
  if (!before) return { ok: false, kind: "NOT_FOUND" };
  if (!(await change.apply(before))) return { ok: false, kind: "NO_CHANGE" };

  await writeAudit(ctx, {
    ...change.audit(before),
    resourceType: "user",
    resourceId: userId,
    organizationId: organizationOf(before),
  });
  return { ok: true, user: toUserDto((await findUser(userId))!) };
}

export function changeRole(ctx: AuthContext, userId: string, role: Role) {
  return changeAccount(ctx, userId, {
    apply: async (before) => {
      if (before.role === role) return false;
      await prisma.user.update({ where: { id: userId }, data: { role } });
      return true;
    },
    audit: (before) => ({
      action: "ADMIN_USER_ROLE_CHANGED",
      metadata: { from: before.role, to: role },
    }),
  });
}

/**
 * Suspend an account: block sign-in and end every session it holds.
 *
 * Ending the sessions is what makes it immediate. The sign-in block alone
 * would leave an already signed-in account working until its session expired.
 */
export function suspendUser(ctx: AuthContext, userId: string, reason: string) {
  return changeAccount(ctx, userId, {
    apply: () =>
      prisma.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: userId, suspendedAt: null },
          data: { suspendedAt: new Date() },
        });
        if (updated.count === 0) return false;
        await tx.session.deleteMany({ where: { userId } });
        return true;
      }),
    audit: () => ({ action: "ADMIN_USER_SUSPENDED", metadata: { reason } }),
  });
}

export function unsuspendUser(ctx: AuthContext, userId: string, reason: string) {
  return changeAccount(ctx, userId, {
    apply: async () => {
      const updated = await prisma.user.updateMany({
        where: { id: userId, suspendedAt: { not: null } },
        data: { suspendedAt: null },
      });
      return updated.count > 0;
    },
    audit: (before) => ({
      action: "ADMIN_USER_UNSUSPENDED",
      metadata: { reason, suspendedAt: before.suspendedAt },
    }),
  });
}

export type GrantAdminResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: "NOT_FOUND" | "EMAIL_NOT_VERIFIED" | "SUSPENDED" | "ALREADY_ADMIN";
    };

/**
 * Create an administrator from the deployment host (ADR-0009).
 *
 * The role is never granted at signup, so the first administrator has to come
 * from somewhere no user of the application can reach. Nobody performed this
 * through the application, so the audit record names no user; its metadata
 * says where it came from.
 */
export async function grantAdminFromHost(
  email: string,
): Promise<GrantAdminResult> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: userSelect,
  });
  if (!user) return { ok: false, reason: "NOT_FOUND" };
  // An unconfirmed address may belong to someone else who registered it
  // first, which is the attack an environment-variable grant was rejected for.
  if (!user.emailVerified) return { ok: false, reason: "EMAIL_NOT_VERIFIED" };
  if (user.suspendedAt) return { ok: false, reason: "SUSPENDED" };
  if (user.role === "ADMIN") return { ok: false, reason: "ALREADY_ADMIN" };

  await prisma.user.update({
    where: { id: user.id },
    data: { role: "ADMIN" },
  });

  await writeSystemAudit(organizationOf(user), {
    action: "ADMIN_ROLE_GRANTED",
    resourceType: "user",
    resourceId: user.id,
    metadata: { source: "cli", from: user.role, email: user.email },
  });
  return { ok: true, userId: user.id };
}
