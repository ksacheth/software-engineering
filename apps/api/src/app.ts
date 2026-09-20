import cors from "cors";
import cookieParser from "cookie-parser";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { config } from "./config/env";
import { healthRouter } from "./common/health.router";
import { createAuthRouter } from "./modules/auth/auth.routes";
import { createMeRouter } from "./modules/auth/me.routes";
import { createTargetsRouter } from "./modules/targets/targets.routes";
import { createScansRouter } from "./modules/scans/scans.routes";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  // F.1/F.8: behind nginx and the Vite dev proxy this makes req.ip the real
  // client address, so audit records and rate limits key on the caller rather
  // than on the proxy. See config.trustProxy for why loopback is the default.
  app.set("trust proxy", config.trustProxy);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.use("/api/health", healthRouter);
  app.use("/api/auth", createAuthRouter());
  app.use("/api/me", createMeRouter());
  app.use("/api/targets", createTargetsRouter());
  app.use("/api/scans", createScansRouter());

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: "Not Found" });
  });

  // Central error handler (must keep 4 args for Express).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // TODO(F.8): structured logging + append-only audit trail integration.
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  });

  return app;
}
