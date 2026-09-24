import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { ApiError } from "../src/api/errors.ts";
import { loadConfig } from "../src/config.ts";
import { ContentService } from "../src/content/service.ts";
import { migrateUp } from "../src/database/migrator.ts";

const { Pool } = pg;
const schema = `content_test_${randomBytes(8).toString("hex")}`;
if (!/^content_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid schema");
const config = loadConfig();
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 3,
  options: `-c search_path=${schema},public`,
});
const s3 = new S3Client({
  endpoint: `${config.objectStorage.useSsl ? "https" : "http"}://${config.objectStorage.endpoint}:${config.objectStorage.port}`,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.objectStorage.accessKey,
    secretAccessKey: config.objectStorage.secretKey,
  },
});

async function expectCode(action: Promise<unknown>, code: string) {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );
}

async function main(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  try {
    await migrateUp(pool, { schema });
    for (const [workId, pieceId, access] of [
      ["a-work", "a-piece", "free"],
      ["b-work", "b-piece", "free"],
      ["restricted-work", "restricted-piece", "restricted"],
    ] as const) {
      await pool.query(
        "INSERT INTO works (id, title, access_type, status) VALUES ($1, $2, $3, 'published')",
        [workId, `${workId} title`, access],
      );
      await pool.query(
        "INSERT INTO pieces (id, work_id, title, access_type, status) VALUES ($1, $2, $3, $4, 'published')",
        [pieceId, workId, `${pieceId} title`, access],
      );
      const version = await pool.query<{ id: string }>(
        `INSERT INTO content_versions (
           piece_id, content_version, status, publishable, manifest_sha256, published_at
         ) VALUES ($1, 1, 'published', true, $2, now()) RETURNING id`,
        [pieceId, "a".repeat(64)],
      );
      await pool.query("UPDATE pieces SET current_content_version_id = $1 WHERE id = $2", [
        version.rows[0]!.id,
        pieceId,
      ]);
      await pool.query(
        `INSERT INTO content_assets (
           piece_id, content_version, asset_type, bucket, object_key,
           sha256, size_bytes, mime_type, status
         ) VALUES ($1, 1, 'audio', $2, $3, $4, 123, 'audio/mpeg', 'published')`,
        [pieceId, config.objectStorage.publishedBucket, `published/${pieceId}/audio.mp3`, "b".repeat(64)],
      );
    }
    const service = new ContentService(
      pool,
      s3,
      config.auth.identityHashKeyBase64,
    );
    const first = await service.listWorks(undefined, 1);
    assert.equal(first.items[0]?.workId, "a-work");
    assert.ok(first.nextCursor);
    const second = await service.listWorks(first.nextCursor!, 1);
    assert.equal(second.items[0]?.workId, "b-work");
    await expectCode(service.listWorks(`${first.nextCursor}tampered`, 1), "INVALID_REQUEST");

    const work = await service.getWork("a-work");
    assert.equal(work.pieces[0]?.currentContentVersion, 1);
    const manifest = await service.getManifest("a-piece");
    assert.equal(manifest.contentVersion, 1);
    assert.match(manifest.assets[0]!.url, /X-Amz-(?:Signature|Credential)=/i);
    await expectCode(service.getManifest("a-piece", 2), "CONTENT_VERSION_UNAVAILABLE");
    await expectCode(service.getManifest("restricted-piece"), "CONTENT_ACCESS_DENIED");
    process.stdout.write("content.smoke.passed cursor=signed manifest=presigned restricted=blocked\n");
  } finally {
    s3.destroy();
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
