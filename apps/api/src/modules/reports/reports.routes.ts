import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole } from "../../common/session";
import { sendProblem } from "../../common/problem";
import { parseOr400 } from "../../common/validate";
import { createReportSchema, shareReportSchema } from "./report-request";
import {
  downloadReport,
  downloadShared,
  getReport,
  listReports,
  requestReport,
  revokeShare,
  shareReport,
  type DownloadResult,
} from "./report-service";

/**
 * F.7 reports.
 *
 * Every role may request and read reports, since the VIEWER persona's need is
 * an exportable posture summary. Sharing hands a file to someone outside the
 * organisation, so it needs a write role (ADR-0011). The shared download is the
 * one route without a session, and it is registered before the guard.
 */

const SHARE_WRITERS = ["ADMIN", "ANALYST", "DEVELOPER"] as const;

function sendNotFound(res: Response): void {
  // Another organisation's report is not found, not forbidden: the response
  // must not confirm that it exists.
  sendProblem(res, { title: "Not Found", status: 404 });
}

/**
 * Report files are served as attachments under a sandbox policy. An HTML
 * report is mostly text the scanned site chose, and must never run as a page
 * on this origin.
 */
function sendFile(res: Response, file: Extract<DownloadResult, { ok: true }>): void {
  res
    .status(200)
    .set({
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    })
    .send(file.bytes);
}

function sendDownloadFailure(
  res: Response,
  reason: Exclude<DownloadResult, { ok: true }>["reason"],
): void {
  switch (reason) {
    case "NOT_FOUND":
      sendNotFound(res);
      return;
    case "NOT_READY":
      sendProblem(res, {
        title: "Report not ready",
        status: 409,
        detail: "This report has not finished generating.",
        code: "REPORT_NOT_READY",
      });
      return;
    case "EXPIRED":
      sendProblem(res, {
        title: "Report expired",
        status: 410,
        detail:
          "This report contains evidence that has passed its retention period, so it is no longer served. Generate a new report.",
        code: "REPORT_EXPIRED",
      });
      return;
    case "EVIDENCE_WITHHELD":
      sendProblem(res, {
        title: "Forbidden",
        status: 403,
        detail: "This report contains raw evidence, which your role cannot read.",
        code: "EVIDENCE_WITHHELD",
      });
      return;
    case "FILE_MISSING":
      sendProblem(res, {
        title: "Report file missing",
        status: 410,
        detail: "The file for this report is no longer stored. Generate a new report.",
        code: "REPORT_FILE_MISSING",
      });
      return;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createReportsRouter(): Router {
  const router = Router();

  // ------------------------------------------------- shared (no session) ---
  router.get("/shared/:token", async (req: Request, res: Response, next) => {
    try {
      const result = await downloadShared(req.params.token!);
      if (!result.ok) {
        sendNotFound(res);
        return;
      }
      sendFile(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.use(requireAuth);
  const requireShareWriter = requireRole(...SHARE_WRITERS);

  // -------------------------------------------------------------- request ---
  router.post("/", async (req: Request, res: Response, next) => {
    try {
      const body = parseOr400(createReportSchema, req.body, res, "The report request is invalid.");
      if (!body) return;
      const result = await requestReport(req.auth!, body);
      if (result.ok) {
        res.status(202).json({ report: result.report });
        return;
      }
      if (result.reason === "SCAN_NOT_FOUND") {
        sendNotFound(res);
      } else if (result.reason === "SCAN_NOT_COMPLETED") {
        sendProblem(res, {
          title: "Scan not completed",
          status: 409,
          detail: "Reports can only be generated for a completed scan.",
          code: "SCAN_NOT_COMPLETED",
          scanStatus: result.scanStatus,
        });
      } else {
        sendProblem(res, {
          title: "Report queue unavailable",
          status: 503,
          detail: "The report could not be queued. Try again shortly.",
          code: "QUEUE_UNAVAILABLE",
        });
      }
    } catch (error) {
      next(error);
    }
  });

  // ----------------------------------------------------------------- list ---
  router.get("/", async (req: Request, res: Response, next) => {
    try {
      const scanId = req.query.scanId;
      if (scanId !== undefined && !isNonEmptyString(scanId)) {
        sendProblem(res, {
          title: "Validation failed",
          status: 400,
          errors: [{ pointer: "/scanId", detail: "scanId must be given once." }],
        });
        return;
      }
      res.json({ reports: await listReports(req.auth!, { scanId }) });
    } catch (error) {
      next(error);
    }
  });

  // --------------------------------------------------------------- detail ---
  router.get("/:id", async (req: Request, res: Response, next) => {
    try {
      const report = await getReport(req.auth!, req.params.id!);
      if (!report) {
        sendNotFound(res);
        return;
      }
      res.json({ report });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------- download ---
  router.get("/:id/download", async (req: Request, res: Response, next) => {
    try {
      const result = await downloadReport(req.auth!, req.params.id!);
      if (!result.ok) {
        sendDownloadFailure(res, result.reason);
        return;
      }
      sendFile(res, result);
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------- share ---
  router.post("/:id/share", requireShareWriter, async (req: Request, res: Response, next) => {
    try {
      const body = parseOr400(shareReportSchema, req.body, res, "The share request is invalid.");
      if (!body) return;
      const result = await shareReport(req.auth!, req.params.id!, body);
      if (result.ok) {
        // The token is returned once. Only its hash is stored (ADR-0011).
        res.status(201).json({
          report: result.report,
          sharePath: result.sharePath,
        });
        return;
      }
      sendDownloadFailure(res, result.reason);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id/share", requireShareWriter, async (req: Request, res: Response, next) => {
    try {
      const report = await revokeShare(req.auth!, req.params.id!);
      if (!report) {
        sendNotFound(res);
        return;
      }
      res.json({ report });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
