import assert from "node:assert/strict";
import test from "node:test";

import { parseRedisConnection } from "../src/queue.ts";

test("Redis URL is converted to BullMQ connection options", () => {
  assert.deepEqual(parseRedisConnection("redis://worker:secret@redis.internal:6380/3"), {
    host: "redis.internal",
    port: 6380,
    username: "worker",
    password: "secret",
    db: 3,
    tls: undefined,
  });
});

test("rediss enables TLS and unsupported protocols are rejected", () => {
  assert.deepEqual(parseRedisConnection("rediss://redis.internal"), {
    host: "redis.internal",
    port: 6379,
    username: undefined,
    password: undefined,
    db: 0,
    tls: {},
  });
  assert.throws(() => parseRedisConnection("http://redis.internal"), /REDIS_URL/);
});
