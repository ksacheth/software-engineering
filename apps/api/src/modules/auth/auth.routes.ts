import { Router } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../../lib/auth';

/**
 * F.1 — User Authentication & Access Control (module 0.1).
 * Mounts Better Auth via toNodeHandler.
 */
export function createAuthRouter(): Router {
  const router = Router();
  router.all('*', toNodeHandler(auth));
  return router;
}
