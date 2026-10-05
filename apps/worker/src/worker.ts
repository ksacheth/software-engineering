declare const process: any;

// @ts-ignore
import { Worker, type Job } from "bullmq";
// @ts-ignore
import Redis from "ioredis";
import { prisma } from "@wvs/database";
import { SCAN_QUEUE_NAME, isScanJobPayload, type ScanJobPayload } from "@wvs/shared";
import { ScanOrchestrator } from "./orchestrator/scan-orchestrator.js";

const REDIS_HOST = (typeof process !== "undefined" && process.env?.REDIS_HOST) || "localhost";
const REDIS_PORT = parseInt((typeof process !== "undefined" && process.env?.REDIS_PORT) || "6379", 10);

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
});

console.log(`[Worker] Starting WVS Scan Worker on queue '${SCAN_QUEUE_NAME}'...`);

export const worker = new Worker(
  SCAN_QUEUE_NAME,
  async (job: any) => {
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

worker.on("completed", (job: any) => {
  console.log(`[Worker] Job ${job.id} completed successfully.`);
});

worker.on("failed", (job: any, err: any) => {
  console.error(`[Worker] Job ${job?.id} failed with error:`, err);
});
