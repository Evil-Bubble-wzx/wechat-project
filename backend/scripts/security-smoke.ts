import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { GetBucketPolicyCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

import { ApiError } from "../src/api/errors.ts";
import { loadConfig } from "../src/config.ts";
import { createInfrastructure } from "../src/infrastructure.ts";
import { RedisRateLimiter } from "../src/security/rate-limiter.ts";

const config = loadConfig();
const infrastructure = createInfrastructure(config);

try {
  const limiter = new RedisRateLimiter(infrastructure.redis);
  const subject = `security-smoke-${randomUUID()}`;
  await limiter.consume("security-smoke", subject, 2, 60);
  await limiter.consume("security-smoke", subject, 2, 60);
  await assert.rejects(
    limiter.consume("security-smoke", subject, 2, 60),
    (error: unknown) => error instanceof ApiError && error.code === "RATE_LIMITED",
  );

  await infrastructure.objectStorage.send(new HeadBucketCommand({ Bucket: config.objectStorage.incomingBucket }));
  await infrastructure.objectStorage.send(new HeadBucketCommand({ Bucket: config.objectStorage.publishedBucket }));
  await assert.rejects(
    infrastructure.objectStorage.send(new GetBucketPolicyCommand({ Bucket: config.objectStorage.incomingBucket })),
    (error: unknown) => error instanceof Error && /AccessDenied|Forbidden|not authorized/i.test(`${error.name} ${error.message}`),
  );
  process.stdout.write("security.smoke.passed rateLimit=redis objectStorage=least-privilege\n");
} finally {
  await infrastructure.close();
}
