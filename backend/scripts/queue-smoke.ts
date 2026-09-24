import { randomUUID } from "node:crypto";

import { Queue, QueueEvents } from "bullmq";

import { loadConfig } from "../src/config.ts";
import { parseRedisConnection } from "../src/queue.ts";

const config = loadConfig();
const connection = parseRedisConnection(config.redisUrl);
const queue = new Queue(config.ingestionQueueName, { connection });
const queueEvents = new QueueEvents(config.ingestionQueueName, { connection });
const requestId = `queue-smoke-${randomUUID()}`;

try {
  await queueEvents.waitUntilReady();
  const job = await queue.add(
    "skeleton.ping",
    { type: "skeleton.ping", requestId },
    {
      jobId: requestId,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
  const result = await job.waitUntilFinished(queueEvents, 10_000);

  if (result?.status !== "ok" || result.requestId !== requestId) {
    throw new Error("Worker returned an unexpected queue smoke result");
  }

  console.info(
    JSON.stringify({
      event: "queue.smoke.passed",
      queue: config.ingestionQueueName,
      jobId: job.id,
      requestId,
    }),
  );
} finally {
  await Promise.allSettled([queue.close(), queueEvents.close()]);
}
