import { prisma, type AuditAction } from '@wvs/database';
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
}

export async function writeAudit(ctx: AuthContext, entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: entry.metadata ? JSON.parse(JSON.stringify(entry.metadata)) : undefined,
      },
    });
  } catch (error) {
    // An audit write must never take down the operation it is recording, but
    // it must be loud: a silent audit gap is worse than a failed request.
    console.error('[audit] failed to write audit record', entry.action, error);
  }
}
