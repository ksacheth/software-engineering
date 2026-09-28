import { Router, type Response } from "express";
import { z } from "zod";
import { BLOCKLIST_PATTERN_TYPES } from "@wvs/scope-rules";
import { sendProblem } from "../../common/problem";
import { parseOr400 } from "../../common/validate";
import {
  createBlocklistEntry,
  deleteBlocklistEntry,
  listBlocklist,
  updateBlocklistEntry,
  type BlocklistWriteResult,
} from "./blocklist";

/**
 * F.8 network blocklist endpoints, mounted behind the administrator guard.
 */

const reason = z.string().trim().min(1).max(500);

const createSchema = z.strictObject({
  patternType: z.enum(BLOCKLIST_PATTERN_TYPES),
  pattern: z.string().min(1).max(200),
  reason,
});

// Strict, so a request to change `pattern` is an error rather than a silently
// ignored field: an entry that blocks something else is a new entry.
const updateSchema = z
  .strictObject({ isActive: z.boolean().optional(), reason: reason.optional() })
  .refine((value) => value.isActive !== undefined || value.reason !== undefined, {
    message: "Change isActive, reason, or both.",
  });

const PROBLEM_DETAIL = {
  UNSUPPORTED_TYPE: "patternType must be CIDR, HOST_SUFFIX or IP_RANGE.",
  MALFORMED_HOST: "pattern must be a hostname, such as gov.example.",
  MALFORMED_CIDR: "pattern must be an address and prefix, such as 10.0.0.0/8.",
  MALFORMED_RANGE:
    "pattern must be two addresses of the same family, lowest first, such as 10.0.0.1-10.0.0.9.",
} as const;

const ENTRY_DETAIL =
  "The blocklist entry contains problems that must be fixed together.";

function sendWrite<T>(
  res: Response,
  result: BlocklistWriteResult<T>,
  onOk: (value: T) => void,
): void {
  if (result.ok) {
    onOk(result.value);
    return;
  }
  if (result.kind === "NOT_FOUND") {
    sendProblem(res, { title: "Not Found", status: 404 });
    return;
  }
  sendProblem(res, {
    title: "Validation failed",
    status: 400,
    detail: ENTRY_DETAIL,
    errors: [{ pointer: "/pattern", detail: PROBLEM_DETAIL[result.problem] }],
  });
}

export function createBlocklistRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({ entries: await listBlocklist() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = parseOr400(createSchema, req.body, res, ENTRY_DETAIL);
      if (!body) return;
      sendWrite(res, await createBlocklistEntry(req.auth!, body), (entry) =>
        res.status(201).json({ entry }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const body = parseOr400(updateSchema, req.body, res, ENTRY_DETAIL);
      if (!body) return;
      sendWrite(
        res,
        await updateBlocklistEntry(req.auth!, req.params.id!, body),
        (entry) => res.json({ entry }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      sendWrite(res, await deleteBlocklistEntry(req.auth!, req.params.id!), () =>
        res.status(204).end(),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
