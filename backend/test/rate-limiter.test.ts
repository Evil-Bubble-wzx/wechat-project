import assert from "node:assert/strict";
import test from "node:test";

import type { Redis } from "ioredis";

import { ApiError } from "../src/api/errors.ts";
import { RedisRateLimiter } from "../src/security/rate-limiter.ts";

test("Redis rate limiter hashes subjects and allows requests within policy", async () => {
  let key = "";
  const redis = {
    async eval(_script: string, _keys: number, suppliedKey: string) {
      key = suppliedKey;
      return [3, 42];
    },
  } as unknown as Redis;
  const limiter = new RedisRateLimiter(redis);
  await limiter.consume("quiz-submit", "user-sensitive-id", 30, 60);
  assert.match(key, /^rate-limit:quiz-submit:[a-f0-9]{64}$/);
  assert.doesNotMatch(key, /user-sensitive-id/);
});

test("Redis rate limiter returns a stable retryable error after the limit", async () => {
  const redis = {
    async eval() { return [31, 17]; },
  } as unknown as Redis;
  const limiter = new RedisRateLimiter(redis);
  await assert.rejects(
    limiter.consume("quiz-submit", "user-001", 30, 60),
    (error: unknown) => error instanceof ApiError
      && error.code === "RATE_LIMITED"
      && error.retryable
      && (error.details as { retryAfterSeconds: number }).retryAfterSeconds === 17,
  );
});
