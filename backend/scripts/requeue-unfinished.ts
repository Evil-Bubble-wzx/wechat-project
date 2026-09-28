import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";

import { loadConfig } from "../src/config.ts";
import { createInfrastructure } from "../src/infrastructure.ts";
import type { IngestionJobPayload } from "../src/ingestion/service.ts";
import { parseRedisConnection } from "../src/queue.ts";
import { RequeueService } from "../src/recovery/requeue-service.ts";

const config = loadConfig();
const infrastructure = createInfrastructure(config);
const queue = new Queue<IngestionJobPayload>(config.ingestionQueueName, {
  connection: parseRedisConnection(config.redisUrl),
});

try {
  const result = await new RequeueService(infrastructure.postgres, queue).rebuild(`recovery-${randomUUID()}`);
  process.stdout.write(`recovery.requeue.passed candidates=${result.candidates} enqueued=${result.enqueued} alreadyPresent=${result.alreadyPresent}\n`);
} finally {
  await queue.close();
  await infrastructure.close();
}
