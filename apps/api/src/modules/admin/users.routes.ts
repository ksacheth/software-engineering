import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import type { AuthContext } from "../../common/session";
import { sendProblem } from "../../common/problem";
import { parseOr400 } from "../../common/validate";
import {
  changeRole,
  listUsers,
  MAX_USER_PAGE_SIZE,
  suspendUser,
  unsuspendUser,
  type AccountChangeResult,
} from "./users";

/** F.8 account administration endpoints, behind the administrator guard. */

const ROLES = ["ADMIN", "ANALYST", "DEVELOPER", "VIEWER"] as const;

const listSchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_USER_PAGE_SIZE).optional(),
  cursor: z.string().min(1).optional(),
});
const roleSchema = z.strictObject({ role: z.enum(ROLES) });
const reasonSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

const REFUSAL = {
  CANNOT_CHANGE_SELF: {
    title: "You cannot change your own account here",
    detail:
      "Ask another administrator. This is also what keeps at least one administrator in the deployment.",
  },
  NO_CHANGE: {
    title: "The account is already in that state",
    detail: undefined,
  },
} as const;

function sendChange(res: Response, result: AccountChangeResult): void {
  if (result.ok) {
    res.json({ user: result.user });
    return;
  }
  if (result.kind === "NOT_FOUND") {
    sendProblem(res, { title: "Not Found", status: 404 });
    return;
  }
  sendProblem(res, { ...REFUSAL[result.kind], status: 409, code: result.kind });
}

/** One account change: validate the body, apply it, answer with the result. */
function accountChange<S extends z.ZodType>(
  schema: S,
  change: (
    ctx: AuthContext,
    userId: string,
    body: z.infer<S>,
  ) => Promise<AccountChangeResult>,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = parseOr400(schema, req.body, res);
      if (!body) return;
      sendChange(res, await change(req.auth!, req.params.id!, body));
    } catch (error) {
      next(error);
    }
  };
}

export function createUsersRouter(): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const query = parseOr400(listSchema, req.query, res);
      if (!query) return;
      res.json(await listUsers(query));
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/:id/role",
    accountChange(roleSchema, (ctx, id, { role }) => changeRole(ctx, id, role)),
  );
  router.post(
    "/:id/suspend",
    accountChange(reasonSchema, (ctx, id, { reason }) =>
      suspendUser(ctx, id, reason),
    ),
  );
  router.post(
    "/:id/unsuspend",
    accountChange(reasonSchema, (ctx, id, { reason }) =>
      unsuspendUser(ctx, id, reason),
    ),
  );

  return router;
}
