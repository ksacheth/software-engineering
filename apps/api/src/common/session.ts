import type { NextFunction, Request, Response } from 'express';
import { auth } from '../lib/auth';

/**
 * Session resolution and organisation scoping (F.1, NFR-SEC-2).
 *
 * Every authenticated route resolves the caller's organisation here rather than
 * accepting it from the request. An organisationId supplied by the client is
 * not an identity claim, and treating it as one is how object-level
 * authorisation fails.
 */

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: string;
  ipAddress?: string;
  userAgent?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function toHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  return headers;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await auth.api.getSession({ headers: toHeaders(req) });

    if (!session?.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const organizationId = session.session?.activeOrganizationId;
    if (!organizationId) {
      // Every user gets an organisation at signup (see lib/auth.ts). A session
      // without one means the signup hook did not complete, so refuse rather
      // than fall back to an unscoped query.
      res.status(403).json({ error: 'No active organisation for this session' });
      return;
    }

    req.auth = {
      userId: session.user.id,
      organizationId,
      role: (session.user as { role?: string }).role ?? 'ANALYST',
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/** Route guard for administrator-only endpoints (F.8). */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
