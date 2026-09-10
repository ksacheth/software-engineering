import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../common/session";

/**
 * F.1: the caller's resolved identity.
 *
 * The dashboard needs the caller's role to decide whether to offer write
 * actions at all. `role` is a domain column Better Auth does not model, so the
 * library's own session response omits it; resolving it on every request is
 * already done for authorisation (`common/session.ts`), and this exposes the
 * same answer rather than letting the client guess or the server accept a
 * claim. The API remains the enforcer: hiding a button is a courtesy, not a
 * control.
 */
export function createMeRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", (req: Request, res: Response) => {
    const auth = req.auth!;
    res.json({
      user: {
        id: auth.userId,
        organizationId: auth.organizationId,
        role: auth.role,
      },
    });
  });

  return router;
}
