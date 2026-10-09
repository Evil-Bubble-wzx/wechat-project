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
import { ProgressSyncService } from "../src/sync/progress-sync-service.ts";
import {
  SavedWordSyncService,
  savedWordBatchIdFor,
  savedWordOperationIdFor,
  type SavedWordSyncOperation,
} from "../src/sync/saved-word-sync-service.ts";

const { Pool } = pg;
const schema = `s04_sync_${randomBytes(8).toString("hex")}`;
if (!/^s04_sync_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid S-04 schema");
const base = loadConfig();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: base.databaseUrl, WECHAT_PROVIDER: "stub" });
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({ connectionString: config.databaseUrl, max: 5, options: `-c search_path=${schema},public` });

async function seed(): Promise<void> {
  await pool.query("INSERT INTO works (id,title,status,access_type) VALUES ('peter-rabbit','Peter Rabbit','published','free')");
  await pool.query("INSERT INTO pieces (id,work_id,title,status,access_type) VALUES ('peter-rabbit-01','peter-rabbit','Peter Rabbit','published','free')");
  const version = await pool.query<{ id: string }>(
    "INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ('peter-rabbit-01',1,'published',true,$1,now()) RETURNING id",
    ["a".repeat(64)],
  );
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='peter-rabbit-01'", [version.rows[0]!.id]);
  await pool.query(
    "INSERT INTO content_assets (piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES ('peter-rabbit-01',1,'audio','test','peter-v1.mp3',$1,1,'audio/mpeg',322026,'published')",
    ["b".repeat(64)],
  );
}

async function secondDeviceToken(userId: string): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(
    "INSERT INTO user_sessions (id,user_id,token_family_id,refresh_token_hash,device_id,expires_at) VALUES ($1,$2,$3,$4,'s04-device-b',now()+interval '1 day')",
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

async function request(address: string, token: string, method: string, path: string, body?: unknown, key?: string) {
  const response = await fetch(`${address}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() as any };
}

const entry = {
  entryId: "ve-5732b4cca2b4",
  pieceId: "peter-rabbit-01",
  contentVersion: 1,
  vocabKey: "a:determiner:1",
  surface: "a",
  lemma: "a",
};
function wordOperation(action: "save" | "delete", baseRevision: string): SavedWordSyncOperation {
  const payload = { ...entry, action, baseRevision, occurredAt: "2026-10-09T00:00:00.000Z" };
  return { operationId: savedWordOperationIdFor(payload), ...payload };
}
function wordBatch(operations: SavedWordSyncOperation[], cursor: string | null = null) {
  const payload = { schemaVersion: 1 as const, cursor, operations, limit: 100 };
  return { batchId: savedWordBatchIdFor(payload), ...payload };
}
const progress = (mutationId: string, baseRevision: string, checkpointMs: number, listenedRangesMs: number[][]) =>
  ({ schemaVersion: 1, mutationId, baseRevision, contentVersion: 1, checkpointMs, listenedRangesMs });

async function main(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  let app: ReturnType<typeof createApp> | undefined;
  try {
    await migrateUp(pool, { schema });
    await seed();
    const sessions = new SessionService(pool, new StubWechatIdentityProvider(), config);
    const deviceA = await sessions.createWechatSession({ code: "test:s04-user-a", deviceId: "s04-device-a", idempotencyKey: "s04-login-a" });
    const tokenB = await secondDeviceToken(deviceA.userId);
    const other = await sessions.createWechatSession({ code: "test:s04-other-user", deviceId: "s04-other-device", idempotencyKey: "s04-login-other" });
    app = createApp({
      appEnv: "test",
      sessionService: sessions,
      progressSyncService: new ProgressSyncService(pool),
      savedWordSyncService: new SavedWordSyncService(pool, config.auth.identityHashKeyBase64),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const piece = "/me/progress/peter-rabbit-01";

    const firstProgress = progress("s04-progress-a-0001", "0", 6000, [[0, 6000]]);
    const aProgress = await request(address, deviceA.accessToken, "PUT", piece, firstProgress, firstProgress.mutationId);
    assert.equal(aProgress.status, 200);
    assert.equal(aProgress.body.progress.revision, "1");
    const bRead = await request(address, tokenB, "GET", piece);
    assert.equal(bRead.body.progress.revision, "1");
    const staleProgress = progress("s04-progress-b-0001", "0", 15000, [[10000, 15000]]);
    const bProgress = await request(address, tokenB, "PUT", piece, staleProgress, staleProgress.mutationId);
    assert.equal(bProgress.body.mergeStatus, "merged_stale_base");
    assert.equal(bProgress.body.progress.checkpointMs, 6000);
    assert.deepEqual((await request(address, deviceA.accessToken, "GET", piece)).body.progress.listenedRangesMs, [[0, 6000], [10000, 15000]]);
    const progressReplay = await request(address, tokenB, "PUT", piece, staleProgress, staleProgress.mutationId);
    assert.equal(progressReplay.body.duplicate, true);

    const saved = wordBatch([wordOperation("save", "0")]);
    const aSaved = await request(address, deviceA.accessToken, "POST", "/me/words/sync", saved, saved.batchId);
    assert.equal(aSaved.body.operations[0].word.state, "saved");
    const bPulled = await request(address, tokenB, "POST", "/me/words/sync", wordBatch([]), wordBatch([]).batchId);
    assert.equal(bPulled.body.changes[0].state, "saved");
    const deleted = wordBatch([wordOperation("delete", "0")]);
    const bDeleted = await request(address, tokenB, "POST", "/me/words/sync", deleted, deleted.batchId);
    assert.equal(bDeleted.body.operations[0].word.state, "deleted");
    const aPulledBatch = wordBatch([], aSaved.body.nextCursor);
    const aPulled = await request(address, deviceA.accessToken, "POST", "/me/words/sync", aPulledBatch, aPulledBatch.batchId);
    assert.equal(aPulled.body.changes[0].state, "deleted");
    const wordReplay = await request(address, tokenB, "POST", "/me/words/sync", deleted, deleted.batchId);
    assert.equal(wordReplay.body.operations[0].word.revision, bDeleted.body.operations[0].word.revision);

    assert.equal((await request(address, other.accessToken, "GET", piece)).body.progress.revision, "0");
    const otherPull = wordBatch([]);
    assert.equal((await request(address, other.accessToken, "POST", "/me/words/sync", otherPull, otherPull.batchId)).body.changes.length, 0);
    const logout = await request(address, deviceA.accessToken, "DELETE", "/session/current", undefined, "s04-logout-a");
    assert.equal(logout.status, 200);
    assert.equal((await request(address, deviceA.accessToken, "GET", piece)).status, 401);
    assert.equal((await request(address, tokenB, "GET", piece)).status, 200);

    process.stdout.write(`s04-sync.smoke.passed schema=${schema} devices=2 progress=merged words=tombstoned replay=idempotent account=isolated logout=revoked\n`);
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
