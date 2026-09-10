import { createServer } from "node:http";
import { createApp } from "./app";
import { config } from "./config/env";
import { startEmailRetryLoop } from "./lib/email";
import { attachScanGateway } from "./modules/scans/scan-gateway";
import { closeScanQueue } from "./modules/scans/scan-queue";

const app = createApp();
const server = createServer(app);

// F.3: the WebSocket gateway shares the HTTP server so /ws and /api are served
// by one process. Only the upgrade listener is added here; the gateway filters
// events per organisation.
const gateway = attachScanGateway(server);

server.listen(config.port, () => {
  console.log(
    `[wvs-api] listening on http://localhost:${config.port}/api (env: ${config.env})`,
  );
});

// SRS §3.2.3: retry queued email. Off by default; the drain belongs in the
// worker app. Enable here only for a single-instance deployment.
if (config.emailRetryIntervalMs > 0) {
  startEmailRetryLoop(config.emailRetryIntervalMs);
  console.log(
    `[wvs-api] email retry loop every ${config.emailRetryIntervalMs}ms ` +
      "(single-instance only)",
  );
}

// Graceful shutdown — finish in-flight requests, then exit.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[wvs-api] ${signal} received, shutting down`);
    void gateway.close();
    void closeScanQueue();
    server.close(() => process.exit(0));
  });
}
