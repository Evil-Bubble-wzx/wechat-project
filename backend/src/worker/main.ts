import { UnrecoverableError, Worker, type Job } from "bullmq";

import { loadConfig } from "../config.ts";
import { createInfrastructure } from "../infrastructure.ts";
import {
  IngestionProcessingError,
  IngestionProcessor,
} from "../ingestion/processor.ts";
import type { IngestionJobPayload } from "../ingestion/service.ts";
import { parseRedisConnection } from "../queue.ts";
import { RankingAggregationService } from "../ranking/aggregation-service.ts";
import { RankingRebuildProcessor } from "../ranking/rebuild-processor.ts";

type SkeletonJob = {
  type: "skeleton.ping";
  requestId?: string;
};

type WorkerJob = SkeletonJob | IngestionJobPayload;

const config = loadConfig();
const infrastructure = createInfrastructure(config);
const ingestionProcessor = new IngestionProcessor(
  infrastructure.postgres,
  infrastructure.objectStorage,
  config.ffprobePath,
);
const rankingRebuildProcessor = new RankingRebuildProcessor(
  infrastructure.postgres,
  new RankingAggregationService(infrastructure.postgres, config.auth.identityHashKeyBase64),
);
const worker = new Worker<WorkerJob>(
  config.ingestionQueueName,
  async (job: Job<WorkerJob>) => {
    if (job.data.type === "skeleton.ping") {
      await job.updateProgress(100);
      return {
        status: "ok",
        jobId: job.id,
        requestId: job.data.requestId,
      };
    }
    if (job.data.type === "content.ingestion.item") {
      try {
        await ingestionProcessor.process(
          job.data.processingJobId,
          job.attemptsMade + 1,
          typeof job.opts.attempts === "number" ? job.opts.attempts : 1,
        );
        await job.updateProgress(100);
        return { status: "ok", processingJobId: job.data.processingJobId };
      } catch (error) {
        if (error instanceof IngestionProcessingError && !error.retryable) {
          throw new UnrecoverableError(`${error.code}: ${error.message}`);
        }
        throw error;
      }
    }
    throw new UnrecoverableError("Unsupported job type");
  },
  {
    connection: parseRedisConnection(config.redisUrl),
    concurrency: config.workerConcurrency,
  },
);

worker.on("completed", (job) => {
  console.info(JSON.stringify({
    event: "worker.job.completed",
    environment: config.appEnv,
    jobId: job.id,
    requestId: job.data.requestId,
    processingJobId: job.data.type === "content.ingestion.item" ? job.data.processingJobId : null,
    residentMemoryBytes: process.memoryUsage().rss,
  }));
});

worker.on("failed", (job, error) => {
  console.error(
    JSON.stringify({
      event: "worker.job.failed",
      environment: config.appEnv,
      jobId: job?.id,
      requestId: job?.data.requestId,
      processingJobId: job?.data.type === "content.ingestion.item" ? job.data.processingJobId : null,
      errorCode: error instanceof IngestionProcessingError ? error.code : "WORKER_JOB_FAILED",
      errorName: error.name,
    }),
  );
});

let shuttingDown = false;
let rankingTickRunning = false;
async function processRankingEvents(): Promise<void> {
  if (rankingTickRunning || shuttingDown) return;
  rankingTickRunning = true;
  try {
    const processed = await rankingRebuildProcessor.processAvailable();
    if (processed > 0) console.info(JSON.stringify({ event: "ranking.rebuild.completed", processed }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "ranking.rebuild.failed",
      environment: config.appEnv,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
  } finally {
    rankingTickRunning = false;
  }
}
const rankingTimer = setInterval(() => void processRankingEvents(), 5_000);
void processRankingEvents();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(rankingTimer);
  console.info(JSON.stringify({ event: "worker.shutdown", signal }));
  await worker.close();
  await infrastructure.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.info(
  JSON.stringify({
    event: "worker.started",
    environment: config.appEnv,
    queue: config.ingestionQueueName,
    concurrency: config.workerConcurrency,
  }),
);
