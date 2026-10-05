import { Router } from 'express';
import { prisma } from '@wvs/database';
import { probe } from '../modules/admin/health';
import { pingScanQueue } from '../modules/scans/scan-queue';

export const healthRouter = Router();

// Liveness probe for the API process (NFR-PERF-1 reads must stay fast).
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * F.8 readiness: whether this instance can serve, meaning both the database and
 * Redis (queues, rate limits, scan events) answer. The orchestration definition
 * holds the dashboard back until this passes. Unauthenticated, so unlike the
 * administrator health view it names the dependencies but never says why one
 * failed.
 */
healthRouter.get('/ready', async (_req, res) => {
  const [database, redis] = (
    await Promise.all([
      probe(async () => {
        await prisma.$queryRaw`SELECT 1`;
        return { ok: true as const };
      }),
      probe(async () => {
        await pingScanQueue();
        return { ok: true as const };
      }),
    ])
  ).map((result) => (result.ok ? 'ok' : 'unavailable'));
  const ready = database === 'ok' && redis === 'ok';
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unavailable',
    checks: { database, redis },
    timestamp: new Date().toISOString(),
  });
});
