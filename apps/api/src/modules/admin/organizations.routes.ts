import { Router } from "express";
import { z } from "zod";
import { ORGANIZATION_QUOTA_BOUNDS } from "@wvs/shared";
import { sendProblem } from "../../common/problem";
import { parseOr400 } from "../../common/validate";
import { changeQuota, listOrganizations } from "./organizations";

/** F.8 quota endpoints, mounted behind the administrator guard. */

const { maxConcurrentScans, scanRateLimit } = ORGANIZATION_QUOTA_BOUNDS;

const quotaSchema = z
  .strictObject({
    maxConcurrentScans: z
      .number()
      .int()
      .min(maxConcurrentScans.min)
      .max(maxConcurrentScans.max)
      .optional(),
    scanRateLimit: z
      .number()
      .int()
      .min(scanRateLimit.min)
      .max(scanRateLimit.max, {
        message: `scanRateLimit may not exceed ${scanRateLimit.max} requests per second, the F.8 safety limit.`,
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.maxConcurrentScans !== undefined ||
      value.scanRateLimit !== undefined,
    { message: "Change maxConcurrentScans, scanRateLimit, or both." },
  );

export function createOrganizationsRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json({ organizations: await listOrganizations() });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id/quota", async (req, res, next) => {
    try {
      const quota = parseOr400(
        quotaSchema,
        req.body,
        res,
        "The quota contains problems that must be fixed together.",
      );
      if (!quota) return;

      const organization = await changeQuota(req.auth!, req.params.id!, quota);
      if (!organization) {
        sendProblem(res, { title: "Not Found", status: 404 });
        return;
      }
      res.json({ organization });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
