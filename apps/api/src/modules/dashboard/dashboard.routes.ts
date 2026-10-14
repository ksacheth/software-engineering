import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../common/session";
import { dashboardSummary } from "./dashboard";

/** The organisation's overview. Reads are open to every role. */
export function createDashboardRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response, next) => {
    try {
      res.json({ summary: await dashboardSummary(req.auth!) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
