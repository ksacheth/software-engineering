import { Router } from 'express';

export const healthRouter = Router();

// Liveness probe for the API process (NFR-PERF-1 reads must stay fast).
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
