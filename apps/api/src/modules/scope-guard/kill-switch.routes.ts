import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../common/session";
import { sendProblem } from "../../common/problem";
import { parseOr400 } from "../../common/validate";
import {
  engageKillSwitch,
  isScanningHalted,
  readKillSwitch,
  releaseKillSwitch,
  type KillSwitchResult,
} from "./kill-switch";

/**
 * F.8 kill switch endpoints (ADR-0008).
 *
 * The admin router mounts these behind the administrator guard. Both changes
 * take a reason, because the audit record is how anyone later learns why every
 * scan in the deployment stopped.
 */

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) });

const REASON_DETAIL = "Say why, so the audit log can explain it later.";

function sendResult(res: Response, result: KillSwitchResult): void {
  if (result.ok) {
    res.json({ killSwitch: result.killSwitch, abortedScans: result.abortedScans });
    return;
  }
  sendProblem(res, {
    title:
      result.kind === "ALREADY_ENGAGED"
        ? "The kill switch is already engaged"
        : "The kill switch is not engaged",
    status: 409,
    code: result.kind,
  });
}

export function createKillSwitchRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({ killSwitch: await readKillSwitch() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/engage", async (req, res, next) => {
    try {
      const body = parseOr400(reasonSchema, req.body, res, REASON_DETAIL);
      if (!body) return;
      sendResult(res, await engageKillSwitch(req.auth!, body.reason));
    } catch (error) {
      next(error);
    }
  });

  router.post("/release", async (req, res, next) => {
    try {
      const body = parseOr400(reasonSchema, req.body, res, REASON_DETAIL);
      if (!body) return;
      sendResult(res, await releaseKillSwitch(req.auth!, body.reason));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * What every signed-in user may know about the system: whether scanning is
 * halted, so the dashboard can say so instead of letting a start fail.
 */
export function createSystemStatusRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/status", async (_req, res, next) => {
    try {
      res.json({ killSwitch: { engaged: await isScanningHalted() } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
