import { Router, type Request, type Response } from 'express';
import { prisma } from '@wvs/database';
import { isScannable, toVerifiedIpRanges, verificationExpiryFrom } from '@wvs/scope-rules';
import { requireAuth } from '../../common/session';
import { writeAudit } from '../../common/audit';
import { classifyOrigin, describeRefusal, parseOrigin } from './origin';
import {
  checkDnsTxt,
  checkWellKnown,
  describeChallengeFailure,
  generateVerificationToken,
  TXT_RECORD_PREFIX,
  WELL_KNOWN_PATH,
} from './challenge';
import {
  acquireVerificationSlot,
  describeLimitRefusal,
} from './verification-limits';

/**
 * F.2 — Target Management and Authorisation (module 0.2).
 *
 * Every route is organisation-scoped from the session, never from the request
 * body (NFR-SEC-2). Registration and verification both run the address refusal
 * gate; see docs/verification-protocol.md.
 */

const VERIFICATION_METHODS = new Set(['DNS_TXT', 'WELL_KNOWN']);

function badRequest(res: Response, message: string, extra?: Record<string, unknown>) {
  res.status(400).json({ error: message, ...extra });
}

/** Paths are stored as prefixes; reject anything that is not one. */
function normalisePaths(input: unknown): string[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (!trimmed.startsWith('/') || trimmed.length > 512) return null;
    out.push(trimmed);
  }
  return out;
}

export function createTargetsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  // ---------------------------------------------------------------- list ---
  router.get('/', async (req: Request, res: Response, next) => {
    try {
      const { organizationId } = req.auth!;
      const includeArchived = req.query.includeArchived === 'true';

      const targets = await prisma.target.findMany({
        where: { organizationId, ...(includeArchived ? {} : { isArchived: false }) },
        orderBy: { createdAt: 'desc' },
      });

      res.json({
        targets: targets.map((t) => ({
          ...t,
          verificationToken: undefined, // Never leak the proof in a list view.
          scannable: isScannable(t),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------ register ---
  router.post('/', async (req: Request, res: Response, next) => {
    try {
      const ctx = req.auth!;
      const { origin, label, authorisationAck, verificationMethod } = req.body ?? {};

      if (typeof origin !== 'string' || typeof label !== 'string' || !label.trim()) {
        return badRequest(res, 'origin and label are required');
      }

      // F.2: the acknowledgement is a precondition of registration, not a
      // setting to be toggled afterwards. It is written once and never edited.
      if (authorisationAck !== true) {
        return badRequest(
          res,
          'You must acknowledge that you are authorised to scan this target before registering it.',
        );
      }

      const method = verificationMethod ?? 'DNS_TXT';
      if (!VERIFICATION_METHODS.has(method)) {
        return badRequest(res, 'verificationMethod must be DNS_TXT or WELL_KNOWN');
      }

      const includedPaths = normalisePaths(req.body?.includedPaths);
      const excludedPaths = normalisePaths(req.body?.excludedPaths);
      if (!includedPaths || !excludedPaths) {
        return badRequest(res, 'includedPaths and excludedPaths must be arrays of absolute paths');
      }

      const classified = await classifyOrigin(origin);
      if (!classified.ok) {
        await writeAudit(ctx, {
          action: 'TARGET_REFUSED',
          resourceType: 'target',
          metadata: { origin, refusal: classified.refusal },
        });
        return res.status(422).json({
          error: describeRefusal(classified.refusal),
          rule: classified.refusal,
        });
      }

      const canonicalOrigin = classified.parsed.origin;

      const existing = await prisma.target.findUnique({
        where: { organizationId_origin: { organizationId: ctx.organizationId, origin: canonicalOrigin } },
      });
      if (existing) {
        return res.status(409).json({
          error: 'This origin is already registered in your organisation.',
          targetId: existing.id,
        });
      }

      const target = await prisma.target.create({
        data: {
          organizationId: ctx.organizationId,
          origin: canonicalOrigin,
          label: label.trim(),
          verificationToken: generateVerificationToken(),
          verificationMethod: method,
          verificationStatus: 'PENDING',
          authorisationAck: true,
          authorisationAckAt: new Date(),
          authorisationAckById: ctx.userId,
          includedPaths,
          excludedPaths,
          createdById: ctx.userId,
        },
      });

      await writeAudit(ctx, {
        action: 'TARGET_CREATED',
        resourceType: 'target',
        resourceId: target.id,
        metadata: { origin: canonicalOrigin, verificationMethod: method },
      });

      res.status(201).json({ target, instructions: buildInstructions(target) });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------- read ---
  router.get('/:id', async (req: Request, res: Response, next) => {
    try {
      const target = await findOwned(req);
      if (!target) return res.status(404).json({ error: 'Target not found' });

      res.json({
        target,
        instructions: buildInstructions(target),
        scannable: isScannable(target),
      });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------- verify ---
  router.post('/:id/verify', async (req: Request, res: Response, next) => {
    try {
      const ctx = req.auth!;
      const target = await findOwned(req);
      if (!target) return res.status(404).json({ error: 'Target not found' });
      if (target.isArchived) return badRequest(res, 'Cannot verify an archived target');

      const slot = await acquireVerificationSlot(target.id, ctx.organizationId);
      if (!slot.allowed) {
        return res.status(429).json({ error: describeLimitRefusal(slot.refusal), rule: slot.refusal });
      }

      try {
        // Re-run the address gate. DNS can change between registration and now,
        // and this is the moment addresses are committed to verifiedIpRanges.
        const classified = await classifyOrigin(target.origin);
        if (!classified.ok) {
          await recordFailure(ctx, target.id, { refusal: classified.refusal });
          return res.status(422).json({
            error: describeRefusal(classified.refusal),
            rule: classified.refusal,
          });
        }

        const result =
          target.verificationMethod === 'DNS_TXT'
            ? await checkDnsTxt(classified.parsed.hostname, target.verificationToken)
            : await checkWellKnown(
                classified.parsed.origin,
                target.verificationToken,
                classified.addresses[0]!,
              );

        if (!result.ok) {
          await recordFailure(ctx, target.id, { failure: result.failure, detail: result.detail });
          return res.status(422).json({
            error: describeChallengeFailure(
              result.failure,
              target.verificationMethod,
              classified.parsed.hostname,
            ),
            rule: result.failure,
          });
        }

        const verifiedAt = new Date();
        const updated = await prisma.target.update({
          where: { id: target.id },
          data: {
            verificationStatus: 'VERIFIED',
            verifiedAt,
            verificationExpiresAt: verificationExpiryFrom(verifiedAt),
            verifiedIpRanges: toVerifiedIpRanges(classified.addresses),
          },
        });

        await writeAudit(ctx, {
          action: 'TARGET_VERIFIED',
          resourceType: 'target',
          resourceId: target.id,
          metadata: {
            method: target.verificationMethod,
            addresses: updated.verifiedIpRanges,
            expiresAt: updated.verificationExpiresAt,
          },
        });

        res.json({ target: updated, scannable: isScannable(updated) });
      } finally {
        await slot.release();
      }
    } catch (error) {
      next(error);
    }
  });

  // --------------------------------------------------------------- scope ---
  router.patch('/:id/scope', async (req: Request, res: Response, next) => {
    try {
      const ctx = req.auth!;
      const target = await findOwned(req);
      if (!target) return res.status(404).json({ error: 'Target not found' });

      const includedPaths = normalisePaths(req.body?.includedPaths);
      const excludedPaths = normalisePaths(req.body?.excludedPaths);
      if (!includedPaths || !excludedPaths) {
        return badRequest(res, 'includedPaths and excludedPaths must be arrays of absolute paths');
      }

      // Editing scope does not change who controls the origin, so it does not
      // invalidate the proof. It does change what gets scanned, so it is
      // audited, and the scope in force is snapshotted onto each ScanJob.
      const updated = await prisma.target.update({
        where: { id: target.id },
        data: { includedPaths, excludedPaths },
      });

      await writeAudit(ctx, {
        action: 'TARGET_SCOPE_CHANGED',
        resourceType: 'target',
        resourceId: target.id,
        metadata: {
          before: { includedPaths: target.includedPaths, excludedPaths: target.excludedPaths },
          after: { includedPaths, excludedPaths },
        },
      });

      res.json({ target: updated });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------- archive ---
  router.post('/:id/archive', async (req: Request, res: Response, next) => {
    try {
      const ctx = req.auth!;
      const target = await findOwned(req);
      if (!target) return res.status(404).json({ error: 'Target not found' });

      const updated = await prisma.target.update({
        where: { id: target.id },
        data: { isArchived: true, archivedAt: new Date() },
      });

      await writeAudit(ctx, {
        action: 'TARGET_ARCHIVED',
        resourceType: 'target',
        resourceId: target.id,
      });

      res.json({ target: updated });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------- delete ---
  router.delete('/:id', async (req: Request, res: Response, next) => {
    try {
      const ctx = req.auth!;
      const target = await findOwned(req);
      if (!target) return res.status(404).json({ error: 'Target not found' });

      // Scans and findings cascade. url_ledger and audit_log do not: they carry
      // no foreign key precisely so this delete can succeed (docs/adr/0002).
      await prisma.target.delete({ where: { id: target.id } });

      await writeAudit(ctx, {
        action: 'TARGET_DELETED',
        resourceType: 'target',
        resourceId: target.id,
        metadata: { origin: target.origin },
      });

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function findOwned(req: Request) {
  return prisma.target.findFirst({
    where: { id: req.params.id, organizationId: req.auth!.organizationId },
  });
}

async function recordFailure(
  ctx: { userId: string; organizationId: string; ipAddress?: string; userAgent?: string; role: string },
  targetId: string,
  metadata: Record<string, unknown>,
) {
  await prisma.target.update({
    where: { id: targetId },
    data: { verificationStatus: 'FAILED' },
  });
  await writeAudit(ctx, {
    action: 'TARGET_VERIFICATION_FAILED',
    resourceType: 'target',
    resourceId: targetId,
    metadata,
  });
}

function buildInstructions(target: {
  origin: string;
  verificationMethod: string;
  verificationToken: string;
}) {
  const hostname = parseOrigin(target.origin).ok
    ? new URL(target.origin).hostname
    : target.origin;

  return target.verificationMethod === 'DNS_TXT'
    ? {
        method: 'DNS_TXT' as const,
        recordName: `${TXT_RECORD_PREFIX}.${hostname}`,
        recordType: 'TXT',
        recordValue: target.verificationToken,
      }
    : {
        method: 'WELL_KNOWN' as const,
        url: `${target.origin}${WELL_KNOWN_PATH}`,
        content: target.verificationToken,
      };
}
