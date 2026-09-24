import { createHash } from "node:crypto";

import type { Redis } from "ioredis";

import { ApiError } from "../api/errors.ts";

export interface RateLimiterPort {
  consume(scope: string, subject: string, limit: number, windowSeconds: number): Promise<void>;
}

const script = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

export class RedisRateLimiter implements RateLimiterPort {
  private readonly redis: Redis;
  constructor(redis: Redis) { this.redis = redis; }

  async consume(scope: string, subject: string, limit: number, windowSeconds: number): Promise<void> {
    const subjectHash = createHash("sha256").update(`${scope}\u0000${subject}`).digest("hex");
    const key = `rate-limit:${scope}:${subjectHash}`;
    const result = await this.redis.eval(script, 1, key, String(windowSeconds)) as [number, number];
    const [current, ttl] = result;
    if (current > limit) {
      throw new ApiError("RATE_LIMITED", 429, true, "Request rate limit exceeded", {
        scope,
        retryAfterSeconds: Math.max(1, ttl),
      });
    }
  }
}
