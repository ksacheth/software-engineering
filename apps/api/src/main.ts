import { createApp } from './app';
import { config } from './config/env';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[wvs-api] listening on http://localhost:${config.port}/api (env: ${config.env})`);
});

// Graceful shutdown — finish in-flight requests, then exit.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[wvs-api] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
