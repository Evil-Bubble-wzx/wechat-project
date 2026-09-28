import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.ts";

test("local configuration has reproducible service defaults", () => {
  const config = loadConfig({});

  assert.equal(config.appEnv, "local");
  assert.equal(config.apiPort, 3100);
  assert.equal(config.ingestionQueueName, "content-ingestion");
  assert.equal(config.objectStorage.incomingBucket, "tingyue-incoming");
  assert.equal(config.auth.wechatProvider, "stub");
  assert.equal(config.auth.accessTokenTtlSeconds, 900);
  assert.equal(config.observability.metricsBearerToken, "local-metrics-token-change-me");
});

test("configuration rejects invalid numeric values", () => {
  assert.throws(() => loadConfig({ API_PORT: "not-a-port" }), /API_PORT/);
  assert.throws(() => loadConfig({ WORKER_CONCURRENCY: "0" }), /WORKER_CONCURRENCY/);
  assert.throws(
    () => loadConfig({ TOKEN_SIGNING_KEY_BASE64: "not-a-32-byte-key" }),
    /TOKEN_SIGNING_KEY_BASE64/,
  );
  assert.throws(
    () => loadConfig({ WECHAT_PROVIDER: "real" }),
    /WECHAT_APP_ID.*WECHAT_APP_SECRET/,
  );
});

test("production configuration rejects local credentials", () => {
  assert.throws(() => loadConfig({ APP_ENV: "prod" }), /Production configuration/);
});
