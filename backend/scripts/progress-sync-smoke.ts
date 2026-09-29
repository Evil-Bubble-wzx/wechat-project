import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { SignJWT } from "jose";
import pg from "pg";

import { createApp } from "../src/api/app.ts";
import { SessionService } from "../src/auth/session-service.ts";
import { StubWechatIdentityProvider } from "../src/auth/wechat-provider.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { decodeKey } from "../src/security/crypto.ts";
import {
  batchIdFor,
  operationIdFor,
  ProgressSyncService,
  type ProgressSyncInput,
  type ProgressSyncOperation,
} from "../src/sync/progress-sync-service.ts";

const { Pool } = pg;
const schema = `progress_sync_${randomBytes(8).toString("hex")}`;
if (!/^progress_sync_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid progress sync schema");
const base = loadConfig();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: base.databaseUrl, WECHAT_PROVIDER: "stub" });
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({ connectionString: config.databaseUrl, max: 5, options: `-c search_path=${schema},public` });

async function seedContent(): Promise<void> {
  await pool.query("INSERT INTO works (id,title,status,access_type) VALUES ('peter-rabbit','Peter Rabbit','published','free')");
  await pool.query("INSERT INTO pieces (id,work_id,title,status,access_type) VALUES ('peter-rabbit-01','peter-rabbit','Peter Rabbit','published','free')");
  const version = await pool.query<{ id: string }>(
    "INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ('peter-rabbit-01',1,'published',true,$1,now()) RETURNING id",
    ["a".repeat(64)],
  );
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='peter-rabbit-01'", [version.rows[0]!.id]);
  await pool.query(
    "INSERT INTO content_assets (piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES ('peter-rabbit-01',1,'audio','test','peter.mp3',$1,1,'audio/mpeg',20000,'published')",
    ["b".repeat(64)],
  );
}

function operation(input: Omit<ProgressSyncOperation, "operationId">): ProgressSyncOperation {
  return { operationId: operationIdFor(input), ...input };
}

function batch(operations: ProgressSyncOperation[], cursor: string | null = null, limit = 100): ProgressSyncInput {
  const payload = { schemaVersion: 1 as const, cursor, operations, limit };
  return { batchId: batchIdFor(payload), ...payload };
}

async function post(address: string, token: string, input: ProgressSyncInput): Promise<{ status: number; body: any }> {
  const response = await fetch(`${address}/api/v1/me/progress/sync`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": input.batchId,
    },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json() };
}

async function createSecondDeviceToken(userId: string): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO user_sessions (id,user_id,token_family_id,refresh_token_hash,device_id,expires_at)
     VALUES ($1,$2,$3,$4,'device-progress-b',now()+interval '1 day')`,
    [sessionId, userId, randomUUID(), createHash("sha256").update(randomBytes(32)).digest("hex")],
  );
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer("tingyue-api")
    .setAudience("tingyue-test")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setJti(randomUUID())
    .sign(decodeKey(config.auth.tokenSigningKeyBase64));
}

async function main(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  let app: ReturnType<typeof createApp> | undefined;
  try {
    await migrateUp(pool, { schema });
    await seedContent();
    const sessions = new SessionService(pool, new StubWechatIdentityProvider(), config);
    const deviceA = await sessions.createWechatSession({ code: "test:progress-user", deviceId: "device-progress-a", idempotencyKey: "login-progress-a" });
    const tokenB = await createSecondDeviceToken(deviceA.userId);
    app = createApp({
      appEnv: "test",
      sessionService: sessions,
      progressSyncService: new ProgressSyncService(pool, config.auth.identityHashKeyBase64),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const first = batch([operation({
      pieceId: "peter-rabbit-01", contentVersion: 1, durationMs: 20_000, baseRevision: "0",
      listenedRangeDeltasMs: [[0, 6_000]], checkpointMs: 6_000, naturalEndObserved: false,
      occurredAt: "2026-09-29T01:00:00.000Z",
    })]);
    const firstResult = await post(address, deviceA.accessToken, first);
    assert.equal(firstResult.status, 200);
    assert.equal(firstResult.body.operations[0].status, "applied");
    assert.equal(firstResult.body.operations[0].progress.revision, "1");

    const stale = batch([operation({
      pieceId: "peter-rabbit-01", contentVersion: 1, durationMs: 20_000, baseRevision: "0",
      listenedRangeDeltasMs: [[6_000, 12_000]], checkpointMs: 2_000, naturalEndObserved: false,
      occurredAt: "2026-09-29T01:00:01.000Z",
    })]);
    const staleResult = await post(address, tokenB, stale);
    assert.equal(staleResult.body.operations[0].status, "merged_stale");
    assert.equal(staleResult.body.operations[0].checkpointDecision, "server_retained");
    assert.equal(staleResult.body.operations[0].progress.checkpointMs, 6_000);
    assert.deepEqual(staleResult.body.operations[0].progress.listenedRangesMs, [[0, 12_000]]);
    assert.equal(staleResult.body.operations[0].progress.revision, "2");

    const future = batch([operation({
      pieceId: "peter-rabbit-01", contentVersion: 1, durationMs: 20_000, baseRevision: "9",
      listenedRangeDeltasMs: [[12_000, 13_000]], checkpointMs: 13_000, naturalEndObserved: false,
      occurredAt: "2026-09-29T01:00:02.000Z",
    })]);
    const futureResult = await post(address, deviceA.accessToken, future);
    assert.equal(futureResult.body.operations[0].status, "rejected");
    assert.equal(futureResult.body.operations[0].reason, "future_revision");

    const completed = batch([operation({
      pieceId: "peter-rabbit-01", contentVersion: 1, durationMs: 20_000, baseRevision: "2",
      listenedRangeDeltasMs: [[12_000, 20_000]], checkpointMs: 20_000, naturalEndObserved: true,
      occurredAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    })]);
    const completedResult = await post(address, tokenB, completed);
    assert.equal(completedResult.body.operations[0].clockStatus, "future_skew");
    assert.equal(completedResult.body.operations[0].progress.completed, true);
    assert.equal(completedResult.body.operations[0].progress.revision, "3");

    const replay = await post(address, tokenB, completed);
    const { requestId: _firstRequestId, ...firstReplayBody } = completedResult.body;
    const { requestId: _secondRequestId, ...secondReplayBody } = replay.body;
    assert.deepEqual(secondReplayBody, firstReplayBody);

    const reused = { ...completed, limit: 99 };
    const reuseResult = await post(address, tokenB, reused);
    assert.equal(reuseResult.status, 409);
    assert.equal(reuseResult.body.error.code, "IDEMPOTENCY_KEY_REUSED");

    const pulled = await post(address, deviceA.accessToken, batch([]));
    assert.equal(pulled.body.changes.length, 1);
    assert.equal(pulled.body.changes[0].revision, "3");
    assert.equal(pulled.body.changes[0].completed, true);

    const stored = await pool.query<{ revision: string; checkpoint_ms: number; last_device_id: string; history_count: string }>(
      `SELECT revision::text,checkpoint_ms,last_device_id,
              (SELECT count(*)::text FROM user_learning_progress_history WHERE user_id=$1) history_count
       FROM user_learning_progress WHERE user_id=$1 AND piece_id='peter-rabbit-01'`,
      [deviceA.userId],
    );
    assert.deepEqual(stored.rows[0], { revision: "3", checkpoint_ms: 20_000, last_device_id: "device-progress-b", history_count: "2" });
    process.stdout.write(`progress-sync.smoke.passed schema=${schema} devices=2 stale=merged checkpoint=causal completion=trusted idempotency=exact\n`);
  } finally {
    if (app) await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
