import { Router } from "express";
import { requireAdmin, requireAuth } from "../../common/session";
import { createKillSwitchRouter } from "../scope-guard/kill-switch.routes";
import { createBlocklistRouter } from "../scope-guard/blocklist.routes";
import { createOrganizationsRouter } from "./organizations.routes";
import { createUsersRouter } from "./users.routes";
import { createAuditRouter, createHealthRouter } from "./audit.routes";

/**
 * F.8 administration API (ADR-0009).
 *
 * One guard for everything under /api/admin: an administrator with two-factor
 * authentication enabled. Mounting the sub-routers behind it means an endpoint
 * added later cannot forget the check.
 */
export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireAdmin);

  router.use("/kill-switch", createKillSwitchRouter());
  router.use("/blocklist", createBlocklistRouter());
  router.use("/organizations", createOrganizationsRouter());
  router.use("/users", createUsersRouter());
  router.use("/audit", createAuditRouter());
  router.use("/health", createHealthRouter());

  return router;
}
