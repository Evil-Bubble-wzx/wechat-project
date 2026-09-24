import { Queue } from "bullmq";

import { createApp } from "./app.ts";
import { SessionService } from "../auth/session-service.ts";
import {
  RealWechatIdentityProvider,
  StubWechatIdentityProvider,
} from "../auth/wechat-provider.ts";
import { loadConfig } from "../config.ts";
import { ContentService } from "../content/service.ts";
import { createInfrastructure } from "../infrastructure.ts";
import { IngestionService, type IngestionJobPayload } from "../ingestion/service.ts";
import { parseRedisConnection } from "../queue.ts";
import { QuizService } from "../quiz/service.ts";
import { RankingQueryService } from "../ranking/query-service.ts";
import { AuditService } from "../observability/audit-service.ts";
import { MetricsRegistry, OperationalMetricsCollector } from "../observability/metrics.ts";
import { RedisRateLimiter } from "../security/rate-limiter.ts";

const config = loadConfig();
const infrastructure = createInfrastructure(config);
const wechatProvider =
  config.auth.wechatProvider === "real"
    ? new RealWechatIdentityProvider(
        config.auth.wechatAppId,
        config.auth.wechatAppSecret,
      )
    : new StubWechatIdentityProvider();
const sessionService = new SessionService(
  infrastructure.postgres,
  wechatProvider,
  config,
);
const ingestionQueue = new Queue<IngestionJobPayload>(config.ingestionQueueName, {
  connection: parseRedisConnection(config.redisUrl),
});
const ingestionService = new IngestionService(
  infrastructure.postgres,
  infrastructure.objectStorage,
  ingestionQueue,
  config.objectStorage.incomingBucket,
  config.objectStorage.publishedBucket,
);
const contentService = new ContentService(
  infrastructure.postgres,
  infrastructure.objectStorage,
  config.auth.identityHashKeyBase64,
);
const quizService = new QuizService(infrastructure.postgres);
const rankingService = new RankingQueryService(
  infrastructure.postgres,
  config.auth.identityHashKeyBase64,
);
const auditService = new AuditService(infrastructure.postgres);
const metrics = new MetricsRegistry();
const operationalMetrics = new OperationalMetricsCollector(infrastructure.postgres);
const app = createApp({
  logger: true,
  appEnv: config.appEnv,
  readinessChecks: infrastructure.readinessChecks,
  sessionService,
  ingestionService,
  contentService,
  quizService,
  rankingService,
  auditService,
  metrics,
  operationalMetrics,
  metricsBearerToken: config.observability.metricsBearerToken,
  rateLimiter: new RedisRateLimiter(infrastructure.redis),
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down API");
  await app.close();
  await ingestionQueue.close();
  await infrastructure.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.apiHost, port: config.apiPort });
} catch (error) {
  app.log.error(error, "API startup failed");
  await ingestionQueue.close();
  await infrastructure.close();
  process.exitCode = 1;
}
