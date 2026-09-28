import { Router } from "express";
import { z } from "zod";
import { AuditAction } from "@wvs/database";
import { parseOr400 } from "../../common/validate";
import { decodeAuditCursor, listAudit, MAX_AUDIT_PAGE_SIZE } from "./audit";
import { readHealth } from "./health";

/** F.8 audit review and health, behind the administrator guard. */

const auditQuerySchema = z.object({
  action: z.enum(AuditAction).optional(),
  organizationId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  resourceType: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_AUDIT_PAGE_SIZE).optional(),
  cursor: z
    .string()
    .refine((value) => decodeAuditCursor(value) !== null, {
      message: "cursor is not a cursor this API issued.",
    })
    .optional(),
});

export function createAuditRouter(): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const query = parseOr400(auditQuerySchema, req.query, res);
      if (!query) return;
      res.json(await listAudit(query));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createHealthRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await readHealth());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
