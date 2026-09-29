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
  SavedWordSyncService,
  savedWordBatchIdFor,
  savedWordOperationIdFor,
  type SavedWordSyncInput,
  type SavedWordSyncOperation,
} from "../src/sync/saved-word-sync-service.ts";

const { Pool } = pg;
const schema = `saved_word_sync_${randomBytes(8).toString("hex")}`;
if (!/^saved_word_sync_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid saved word sync schema");
const base = loadConfig();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: base.databaseUrl, WECHAT_PROVIDER: "stub" });
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({ connectionString: config.databaseUrl, max: 5, options: `-c search_path=${schema},public` });

const entry = {
  entryId: "ve-5732b4cca2b4",
  pieceId: "peter-rabbit-01",
  contentVersion: 1,
  vocabKey: "a:determiner:1",
  surface: "a",
  lemma: "a",
};

async function seedContent(): Promise<void> {
  await pool.query("INSERT INTO works (id,title,status,access_type) VALUES ('peter-rabbit','Peter Rabbit','published','free')");
  await pool.query("INSERT INTO pieces (id,work_id,title,status,access_type) VALUES ('peter-rabbit-01','peter-rabbit','Peter Rabbit','published','free')");
  const version = await pool.query<{ id: string }>(
    "INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ('peter-rabbit-01',1,'published',true,$1,now()) RETURNING id",
    ["a".repeat(64)],
  );
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='peter-rabbit-01'", [version.rows[0]!.id]);
}

function operation(input: Omit<SavedWordSyncOperation, "operationId">): SavedWordSyncOperation {
  return { operationId: savedWordOperationIdFor(input), ...input };
}

function mutation(action: "save" | "delete", baseRevision: string, occurredAt = "2026-09-29T01:00:00.000Z"): SavedWordSyncOperation {
  return operation({ ...entry, action, baseRevision, occurredAt });
}

function batch(operations: SavedWordSyncOperation[], cursor: string | null = null, limit = 100): SavedWordSyncInput {
  const payload = { schemaVersion: 1 as const, cursor, operations, limit };
  return { batchId: savedWordBatchIdFor(payload), ...payload };
}

async function post(address: string, token: string, input: SavedWordSyncInput): Promise<{ status: number; body: any }> {
  const response = await fetch(`${address}/api/v1/me/words/sync`, {
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
     VALUES ($1,$2,$3,$4,'device-word-b',now()+interval '1 day')`,
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
    const deviceA = await sessions.createWechatSession({ code: "test:word-user", deviceId: "device-word-a", idempotencyKey: "login-word-a" });
    const tokenB = await createSecondDeviceToken(deviceA.userId);
    app = createApp({
      appEnv: "test",
      sessionService: sessions,
      savedWordSyncService: new SavedWordSyncService(pool, config.auth.identityHashKeyBase64),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const first = batch([mutation("save", "0")]);
    const firstResult = await post(address, deviceA.accessToken, first);
    assert.equal(firstResult.status, 200);
    assert.equal(firstResult.body.operations[0].word.revision, "1");
    assert.equal(firstResult.body.operations[0].word.state, "saved");

    const staleDelete = batch([mutation("delete", "0")]);
    const deleted = await post(address, tokenB, staleDelete);
    assert.equal(deleted.body.operations[0].status, "merged_stale");
    assert.equal(deleted.body.operations[0].reason, "delete_wins");
    assert.equal(deleted.body.operations[0].word.revision, "2");
    assert.equal(deleted.body.operations[0].word.state, "deleted");

    const staleSave = batch([mutation("save", "1")]);
    const blocked = await post(address, deviceA.accessToken, staleSave);
    assert.equal(blocked.body.operations[0].status, "unchanged");
    assert.equal(blocked.body.operations[0].decision, "server_retained");
    assert.equal(blocked.body.operations[0].word.state, "deleted");

    const restore = batch([mutation("save", "2", new Date(Date.now() + 10 * 60_000).toISOString())]);
    const restored = await post(address, tokenB, restore);
    assert.equal(restored.body.operations[0].clockStatus, "future_skew");
    assert.equal(restored.body.operations[0].word.revision, "3");
    assert.equal(restored.body.operations[0].word.state, "saved");

    await pool.query("UPDATE content_versions SET status='superseded' WHERE piece_id='peter-rabbit-01' AND content_version=1");
    const version2 = await pool.query<{ id: string }>(
      "INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ('peter-rabbit-01',2,'published',true,$1,now()) RETURNING id",
      ["c".repeat(64)],
    );
    await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='peter-rabbit-01'", [version2.rows[0]!.id]);
    const currentEntry = { ...entry, contentVersion: 2, surface: "A" };
    const versionSave = operation({ ...currentEntry, action: "save", baseRevision: "3", occurredAt: "2026-09-29T01:10:00.000Z" });
    const versioned = await post(address, tokenB, batch([versionSave]));
    assert.equal(versioned.body.operations[0].word.revision, "4");
    assert.equal(versioned.body.operations[0].word.contentVersion, 2);

    const historicalDelete = await post(address, deviceA.accessToken, batch([mutation("delete", "1")]));
    assert.equal(historicalDelete.body.operations[0].status, "merged_stale");
    assert.equal(historicalDelete.body.operations[0].word.revision, "5");
    assert.equal(historicalDelete.body.operations[0].word.contentVersion, 2);
    assert.equal(historicalDelete.body.operations[0].word.state, "deleted");

    const restoreCurrent = operation({ ...currentEntry, action: "save", baseRevision: "5", occurredAt: "2026-09-29T01:11:00.000Z" });
    const currentRestored = await post(address, tokenB, batch([restoreCurrent]));
    assert.equal(currentRestored.body.operations[0].word.revision, "6");
    assert.equal(currentRestored.body.operations[0].word.state, "saved");

    const future = batch([mutation("delete", "9")]);
    const futureResult = await post(address, deviceA.accessToken, future);
    assert.equal(futureResult.body.operations[0].status, "rejected");
    assert.equal(futureResult.body.operations[0].reason, "future_revision");

    const replay = await post(address, tokenB, restore);
    const { requestId: _firstId, ...firstReplay } = restored.body;
    const { requestId: _secondId, ...secondReplay } = replay.body;
    assert.deepEqual(secondReplay, firstReplay);
    const reused = { ...restore, limit: 99 };
    const reuseResult = await post(address, tokenB, reused);
    assert.equal(reuseResult.status, 409);
    assert.equal(reuseResult.body.error.code, "IDEMPOTENCY_KEY_REUSED");

    const pulled = await post(address, deviceA.accessToken, batch([]));
    assert.equal(pulled.body.changes.length, 1);
    assert.equal(pulled.body.changes[0].revision, "6");
    assert.equal(pulled.body.changes[0].state, "saved");
    const stored = await pool.query<{ revision: string; deleted: boolean; last_device_id: string; history_count: string }>(
      `SELECT revision::text,deleted,last_device_id,
              (SELECT count(*)::text FROM user_saved_word_history WHERE user_id=$1) history_count
       FROM user_saved_words WHERE user_id=$1 AND entry_id=$2`,
      [deviceA.userId, entry.entryId],
    );
    assert.deepEqual(stored.rows[0], { revision: "6", deleted: false, last_device_id: "device-word-b", history_count: "5" });
    process.stdout.write(`saved-word-sync.smoke.passed schema=${schema} devices=2 delete=winner stale-save=blocked restore=explicit version-change=preserved idempotency=exact\n`);
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
