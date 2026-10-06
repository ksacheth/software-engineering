import { Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { prisma } from "@wvs/database";
import { SCAN_QUEUE_NAME, isScanJobPayload, type ScanJobPayload } from "@wvs/shared";
import { MockDetector } from "./detectors/mock-detector.js";
import { ScanOrchestrator } from "./orchestrator/scan-orchestrator.js";
import { createScanEngine } from "./engine/scan-engine-factory.js";

// The real engine crawls and runs the Appendix B detectors. The mock detector
// reports fabricated findings and runs only when asked for by name, for offline
// development.
const useMock = process.env.WVS_SCAN_DETECTOR === "mock";

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);

const redisConnection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
};

const publisher = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null,
});

const orchestrator = new ScanOrchestrator({
  prisma,
  redis: publisher,
  detector: MockDetector.analyze,
  engine: useMock ? undefined : await createScanEngine(),
});

console.log(
  `[Worker] Starting WVS Scan Worker on queue '${SCAN_QUEUE_NAME}' with the ${useMock ? "MOCK detector" : "scan engine"}...`,
);

export const worker = new Worker(
  SCAN_QUEUE_NAME,
  async (job: Job) => {
    console.log(`[Worker] Received job ${job.id} (name: ${job.name})`);

    if (!isScanJobPayload(job.data)) {
      console.error(`[Worker] Invalid job payload for job ${job.id}:`, job.data);
      throw new Error(`Invalid scan job payload structure for job ${job.id}`);
    }

    const payload: ScanJobPayload = job.data;
    console.log(`[Worker] Processing scanId: ${payload.scanJobId} (org: ${payload.organizationId}, attempt: ${payload.attempt})`);

    await orchestrator.processScanJob(payload);
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

worker.on("completed", (job: Job) => {
  console.log(`[Worker] Job ${job.id} completed successfully.`);
});

worker.on("failed", (job: Job | undefined, err: Error) => {
  console.error(`[Worker] Job ${job?.id} failed with error:`, err);
});

/** Lets the active job finish and releases its lock before exiting. */
async function shutdown(signal: string): Promise<void> {
  console.log(`[Worker] ${signal} received, shutting down...`);
  await worker.close();
  await publisher.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
