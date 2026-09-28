import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole } from "../../common/session";
import { sendProblem, type ProblemFieldError } from "../../common/problem";
import {
  parseBulkTriageRequest,
  parseFindingListQuery,
  parseTriageRequest,
} from "./finding-request";
import {
  getFindingDetail,
  listFindings,
  listResolvedSince,
} from "./finding-queries";
import { triageFinding, triageFindings } from "./finding-triage";

/**
 * F.6 findings: current posture, per-scan findings, detail and triage.
 *
 * Reads are available to every role; triage requires a write role. The check
 * is applied once, by method, as in the scans and targets routers, so a
 * mutation route added later cannot silently forget it.
 */

const TRIAGE_WRITERS = ["ADMIN", "ANALYST", "DEVELOPER"] as const;

function sendValidation(
  res: Response,
  detail: string,
  errors: ProblemFieldError[],
): void {
  sendProblem(res, { title: "Validation failed", status: 400, detail, errors });
}

function sendNotFound(res: Response): void {
  // Another organisation's finding or scan is not found, not forbidden: the
  // response must not confirm that the object exists.
  sendProblem(res, { title: "Not Found", status: 404 });
}

export function createFindingsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  const requireTriageWriter = requireRole(...TRIAGE_WRITERS);
  router.use((req: Request, res: Response, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    requireTriageWriter(req, res, next);
  });

  // ----------------------------------------------------------------- list ---
  router.get("/", async (req: Request, res: Response, next) => {
    try {
      const parsed = parseFindingListQuery(req.query);
      if (!parsed.ok) {
        sendValidation(res, "The findings query is invalid.", parsed.errors);
        return;
      }
      const result = await listFindings(req.auth!, parsed.value);
      if (result === "SCAN_NOT_FOUND") {
        sendNotFound(res);
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------- resolved since last ---
  // Registered before "/:id" so "resolved" is not read as a finding id.
  router.get("/resolved", async (req: Request, res: Response, next) => {
    try {
      const scanId = req.query.scanId;
      if (typeof scanId !== "string" || scanId.length === 0) {
        sendValidation(res, "A scan is required.", [
          { pointer: "/scanId", detail: "scanId is required." },
        ]);
        return;
      }
      const findings = await listResolvedSince(req.auth!, scanId);
      if (findings === "SCAN_NOT_FOUND") {
        sendNotFound(res);
        return;
      }
      res.json({ findings });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------- bulk triage ---
  router.post("/triage", async (req: Request, res: Response, next) => {
    try {
      const parsed = parseBulkTriageRequest(req.body);
      if (!parsed.ok) {
        sendValidation(res, "The triage request is invalid.", parsed.errors);
        return;
      }
      const result = await triageFindings(req.auth!, parsed.value);
      if (!result.ok) {
        sendNotFound(res);
        return;
      }
      const updated = result.outcomes.filter((o) => o.changed).length;
      res.json({ updated, unchanged: result.outcomes.length - updated });
    } catch (error) {
      next(error);
    }
  });

  // --------------------------------------------------------------- detail ---
  router.get("/:id", async (req: Request, res: Response, next) => {
    try {
      const finding = await getFindingDetail(req.auth!, req.params.id!);
      if (!finding) {
        sendNotFound(res);
        return;
      }
      res.json({ finding });
    } catch (error) {
      next(error);
    }
  });

  // --------------------------------------------------------------- triage ---
  router.put("/:id/triage", async (req: Request, res: Response, next) => {
    try {
      const parsed = parseTriageRequest(req.body);
      if (!parsed.ok) {
        sendValidation(res, "The triage request is invalid.", parsed.errors);
        return;
      }
      const result = await triageFinding(req.auth!, req.params.id!, parsed.value);
      if (!result.ok) {
        sendNotFound(res);
        return;
      }
      const finding = await getFindingDetail(req.auth!, req.params.id!);
      res.json({ finding, changed: result.outcomes[0]!.changed });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
