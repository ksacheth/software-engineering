import { createApp } from './app';
import { config } from './config/env';
import { startEmailRetryLoop } from './lib/email';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[wvs-api] listening on http://localhost:${config.port}/api (env: ${config.env})`);
});

// SRS §3.2.3: retry queued email. Off by default; the drain belongs in the
// worker app. Enable here only for a single-instance deployment.
if (config.emailRetryIntervalMs > 0) {
  startEmailRetryLoop(config.emailRetryIntervalMs);
  console.log(
    `[wvs-api] email retry loop every ${config.emailRetryIntervalMs}ms ` +
      '(single-instance only)',
  );
}

// Graceful shutdown — finish in-flight requests, then exit.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[wvs-api] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
