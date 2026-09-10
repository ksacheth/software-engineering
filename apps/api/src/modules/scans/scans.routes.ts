import { Router, type NextFunction, type Request, type Response } from "express";
import { isScanStatus, SCAN_STATUSES } from "@wvs/shared";
import { requireAuth, requireRole } from "../../common/session";
import { sendProblem } from "../../common/problem";
import { parseStartScanRequest } from "./scan-request";
import { describeNotScannable, startScan, controlScan, type ScanRefusal, type ScanAction } from "./scan-service";
import {
  decodeScanCursor,
  findScanForOrg,
  listScanFindings,
  listScans,
  MAX_PAGE_SIZE,
  toScanDto,
} from "./scan-queries";
import { acquireScanInitiation, MAX_STARTS_PER_MINUTE } from "./scan-initiation";

/**
 * F.3 scan trigger, progress reads and control.
 *
 * Reads are available to every role; state changes require a write role. The
 * check is applied once, by method, so a mutation route added later cannot
 * silently forget it.
 */

const SCAN_WRITERS = ["ADMIN", "ANALYST", "DEVELOPER"] as const;

function sendRefusal(res: Response, refusal: ScanRefusal): void {
  switch (refusal.kind) {
    case "TARGET_NOT_FOUND":
    case "SCAN_NOT_FOUND":
      // Another organisation's scan is not found, not forbidden: the response
      // must not confirm that the object exists.
      sendProblem(res, { title: "Not Found", status: 404 });
      return;
    case "TARGET_NOT_SCANNABLE":
      sendProblem(res, {
        title: "Target cannot be scanned",
        status: 422,
        detail: describeNotScannable(refusal.reason),
        code: refusal.reason,
      });
      return;
    case "ORG_CONCURRENCY":
      sendProblem(res, {
        title: "Concurrent scan limit reached",
        status: 429,
        detail: `Your organisation may run ${refusal.limit} concurrent scan${refusal.limit === 1 ? "" : "s"}. Wait for one to finish, or cancel one you no longer need.`,
        code: "ORG_CONCURRENCY_LIMIT",
      });
      return;
    case "TARGET_ALREADY_ACTIVE":
      sendProblem(res, {
        title: "A scan of this target is already active",
        status: 409,
        detail:
          "Only one scan per target may be active at a time. Wait for it to finish, or cancel it and start again.",
        code: "TARGET_ALREADY_ACTIVE",
        scanJobId: refusal.scanJobId,
      });
      return;
    case "QUEUE_UNAVAILABLE":
      sendProblem(res, {
        title: "Scan queue unavailable",
        status: 503,
        detail:
          "The scan was recorded but could not be handed to the scan engine, so it will not run. Cancel it from the scans list, then try again once the queue is back.",
        code: "QUEUE_UNAVAILABLE",
      });
      return;
    case "ILLEGAL_TRANSITION":
      sendProblem(res, {
        title: "Scan is not in a state that allows that action",
        status: 409,
        detail: refusal.detail,
        code: `CANNOT_${refusal.action.toUpperCase()}`,
        scanStatus: refusal.status,
      });
      return;
  }
}

export function createScansRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  const requireScanWriter = requireRole(...SCAN_WRITERS);
  router.use((req: Request, res: Response, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    requireScanWriter(req, res, next);
  });

  // ---------------------------------------------------------------- start ---
  router.post("/", async (req: Request, res: Response, next) => {
    try {
      const ctx = req.auth!;
      const parsed = parseStartScanRequest(req.body);
      if (!parsed.ok) {
        sendProblem(res, {
          title: "Validation failed",
          status: 400,
          detail: "The scan request contains problems that must be fixed together.",
          errors: parsed.errors,
        });
        return;
      }

      const limit = await acquireScanInitiation(ctx.organizationId);
      if (!limit.allowed) {
        sendProblem(res, {
          title: "Too many scan requests",
          status: 429,
          detail: `You can start at most ${MAX_STARTS_PER_MINUTE} scans per minute. Try again in ${limit.retryAfterSeconds}s.`,
          code: "SCAN_RATE_LIMITED",
        });
        return;
      }

      const result = await startScan(ctx, parsed.value);
      if (!result.ok) {
        sendRefusal(res, result.refusal);
        return;
      }

      // Returned immediately so the client is not left waiting on a request
      // that runs for minutes (F.3).
      res.status(202).json({ scan: result.scan });
    } catch (error) {
      next(error);
    }
  });

  // ----------------------------------------------------------------- list ---
  router.get("/", async (req: Request, res: Response, next) => {
    try {
      const ctx = req.auth!;

      const statusParam = req.query.status;
      if (
        statusParam !== undefined &&
        (typeof statusParam !== "string" || !isScanStatus(statusParam))
      ) {
        sendProblem(res, {
          title: "Validation failed",
          status: 400,
          detail: "Unknown scan status filter.",
          errors: [
            {
              pointer: "/status",
              detail: `status must be one of: ${SCAN_STATUSES.join(", ")}`,
            },
          ],
        });
        return;
      }

      const limitParam = req.query.limit;
      const limit =
        typeof limitParam === "string" ? Number(limitParam) : undefined;
      if (
        limit !== undefined &&
        (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
      ) {
        sendProblem(res, {
          title: "Validation failed",
          status: 400,
          detail: "Invalid page size.",
          errors: [
            {
              pointer: "/limit",
              detail: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
            },
          ],
        });
        return;
      }

      const cursorParam = req.query.cursor;
      if (
        typeof cursorParam === "string" &&
        cursorParam.length > 0 &&
        !decodeScanCursor(cursorParam)
      ) {
        sendProblem(res, {
          title: "Validation failed",
          status: 400,
          detail: "Invalid cursor.",
          errors: [{ pointer: "/cursor", detail: "cursor is not a cursor this API issued." }],
        });
        return;
      }

      const result = await listScans(ctx, {
        targetId: typeof req.query.targetId === "string" ? req.query.targetId : undefined,
        status: statusParam,
        limit,
        cursor: typeof cursorParam === "string" ? cursorParam : undefined,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------ get ---
  router.get("/:id", async (req: Request, res: Response, next) => {
    try {
      const scan = await findScanForOrg(req.auth!, req.params.id!);
      if (!scan) {
        sendRefusal(res, { kind: "SCAN_NOT_FOUND" });
        return;
      }
      res.json({ scan: toScanDto(scan) });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------ findings ---
  // Read-only projection for the live view: F.6 owns deduplication, triage and
  // evidence, so this carries finding identity and severity only.
  router.get("/:id/findings", async (req: Request, res: Response, next) => {
    try {
      const scan = await findScanForOrg(req.auth!, req.params.id!);
      if (!scan) {
        sendRefusal(res, { kind: "SCAN_NOT_FOUND" });
        return;
      }
      res.json({ findings: await listScanFindings(scan.id) });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------- control ---
  const control = (action: ScanAction) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await controlScan(req.auth!, req.params.id!, action);
      if (!result.ok) {
        sendRefusal(res, result.refusal);
        return;
      }
      res.json({ scan: result.scan });
    } catch (error) {
      next(error);
    }
  };

  router.post("/:id/pause", control("pause"));
  router.post("/:id/resume", control("resume"));
  router.post("/:id/cancel", control("cancel"));

  return router;
}
