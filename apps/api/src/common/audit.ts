import { prisma, type AuditAction, type Prisma } from '@wvs/database';
import type { AuthContext } from './session';

/**
 * F.8 — append-only audit log.
 *
 * `audit_log` records user and administrator actions. It is NOT the URL ledger,
 * which records every outbound HTTP request a scan makes; see CONTEXT.md.
 *
 * The table is INSERT-only for the wvs_app role and protected by triggers
 * (docs/adr/0002), so there is no update or delete path here by design.
 */

export interface AuditEntry {
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  /** Free-form context. Never put credentials, tokens, or evidence bodies here. */
  metadata?: Record<string, unknown>;
  /**
   * The organisation the record belongs to, when it is not the actor's own.
   *
   * An administrator acts across organisations (ADR-0009): aborting another
   * organisation's scan belongs in that organisation's trail, and a
   * deployment-wide action such as the kill switch belongs to none, so it is
   * null. Omitted, the record belongs to the actor's organisation.
   */
  organizationId?: string | null;
}

/**
 * Record an action no user performed.
 *
 * Unattended actors still change state, and F.8 wants one record per event
 * either way. `userId` stays null rather than being attributed to whoever
 * happened to trigger the run: a reconciler's decision is the system's, and
 * naming a user for it would make the audit log say something untrue.
 */
export async function writeSystemAudit(
  organizationId: string | null,
  entry: AuditEntry,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        userId: null,
        organizationId,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        metadata: entry.metadata
          ? JSON.parse(JSON.stringify(entry.metadata))
          : undefined,
      },
    });
  } catch (error) {
    console.error('[audit] failed to write system audit record', entry.action, error);
  }
}

/**
 * The row `writeAudit` would insert, for a caller that must write it inside its
 * own transaction.
 *
 * `writeAudit` never fails the operation it records, which is right when the
 * record follows the change. Where the record and the change must commit
 * together, so a crash cannot leave one without the other, the caller inserts
 * this in the same transaction instead, and a failed insert rolls both back.
 */
export function auditRow(
  ctx: AuthContext,
  entry: AuditEntry,
): Prisma.AuditLogCreateManyInput {
  return {
    action: entry.action,
    userId: ctx.userId,
    organizationId:
      entry.organizationId === undefined
        ? ctx.organizationId
        : entry.organizationId,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    metadata: entry.metadata ? JSON.parse(JSON.stringify(entry.metadata)) : undefined,
  };
}

export async function writeAudit(ctx: AuthContext, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({ data: auditRow(ctx, entry) });
  } catch (error) {
    // An audit write must never take down the operation it is recording, but
    // it must be loud: a silent audit gap is worse than a failed request.
    console.error('[audit] failed to write audit record', entry.action, error);
  }
}
