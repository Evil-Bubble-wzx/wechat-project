import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeleteObjectsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Queue, QueueEvents, UnrecoverableError, Worker } from "bullmq";
import pg from "pg";

import { ApiError } from "../src/api/errors.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp } from "../src/database/migrator.ts";
import {
  IngestionProcessingError,
  IngestionProcessor,
} from "../src/ingestion/processor.ts";
import {
  IngestionService,
  type IngestionItemInput,
  type IngestionJobPayload,
} from "../src/ingestion/service.ts";
import { parseRedisConnection } from "../src/queue.ts";

const { Pool } = pg;
const suffix = randomBytes(8).toString("hex");
const schema = `ingestion_test_${suffix}`;
const queueName = `content-ingestion-smoke-${suffix}`;
if (!/^ingestion_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid test schema");

const config = loadConfig();
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 8,
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
const connection = parseRedisConnection(config.redisUrl);
const queue = new Queue<IngestionJobPayload>(queueName, { connection });
const queueEvents = new QueueEvents(queueName, { connection });
const processor = new IngestionProcessor(pool, s3, config.ffprobePath);
const worker = new Worker<IngestionJobPayload>(
  queueName,
  async (job) => {
    try {
      await processor.process(
        job.data.processingJobId,
        job.attemptsMade + 1,
        typeof job.opts.attempts === "number" ? job.opts.attempts : 1,
      );
    } catch (error) {
      if (error instanceof IngestionProcessingError && !error.retryable) {
        throw new UnrecoverableError(`${error.code}: ${error.message}`);
      }
      throw error;
    }
  },
  { connection, concurrency: 3 },
);

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const pieceRoot = `${projectRoot}content/peter-rabbit/peter-rabbit-01`;
const files = [
  { clientFileId: "audio", assetType: "audio", path: `${pieceRoot}/source/audio-original.mp3`, mimeType: "audio/mpeg" },
  { clientFileId: "subtitles", assetType: "subtitles", path: `${pieceRoot}/dist/cues.json`, mimeType: "application/json" },
  { clientFileId: "text", assetType: "text", path: `${pieceRoot}/source/text-project-gutenberg-14838.txt`, mimeType: "text/plain" },
  { clientFileId: "vocabulary", assetType: "vocabulary", path: `${pieceRoot}/dist/vocab.json`, mimeType: "application/json" },
  { clientFileId: "quiz", assetType: "quiz", path: `${pieceRoot}/dist/quiz.json`, mimeType: "application/json" },
  { clientFileId: "cover", assetType: "cover", path: `${pieceRoot}/source/cover/peter-rabbit-independent.svg`, mimeType: "image/svg+xml" },
  { clientFileId: "metadata", assetType: "metadata", path: `${pieceRoot}/dist/metadata.json`, mimeType: "application/json" },
] as const;

async function declarations(): Promise<IngestionItemInput[]> {
  return Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(file.path);
      return {
        clientFileId: file.clientFileId,
        assetType: file.assetType,
        fileName: basename(file.path),
        sizeBytes: bytes.length,
        mimeType: file.mimeType,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
}

async function cleanupObjects(): Promise<void> {
  const result = await pool.query<{ bucket: string; object_key: string }>(
    `SELECT bucket, object_key FROM upload_sessions
     UNION
     SELECT bucket, object_key FROM processing_artifacts`,
  );
  for (const bucket of new Set(result.rows.map(({ bucket }) => bucket))) {
    const keys = result.rows.filter((row) => row.bucket === bucket).map(({ object_key }) => ({ Key: object_key }));
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
    }
  }
}

async function main(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  try {
    await migrateUp(pool, { schema });
    const actorUserId = randomUUID();
    await pool.query("INSERT INTO users (id) VALUES ($1)", [actorUserId]);
    await pool.query(
      "INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, 'content_admin', 'ingestion-smoke')",
      [actorUserId],
    );
    await pool.query(
      "INSERT INTO works (id, title) VALUES ('peter-rabbit', 'The Tale of Peter Rabbit')",
    );
    await pool.query(
      "INSERT INTO pieces (id, work_id, title) VALUES ('peter-rabbit-01', 'peter-rabbit', 'The Tale of Peter Rabbit')",
    );

    const service = new IngestionService(
      pool,
      s3,
      queue,
      config.objectStorage.incomingBucket,
      config.objectStorage.publishedBucket,
    );
    const declaredItems = await declarations();
    const batch = await service.createBatch(
      {
        source: "peter-rabbit-candidate",
        sourceCommitSha: "7b882b22bfcf535cf2677616cfa82b6bb3d8a70e",
        toolVersion: "ingestion-smoke/1.0.0",
        workId: "peter-rabbit",
        pieceId: "peter-rabbit-01",
        contentVersion: 1,
        items: declaredItems,
      },
      actorUserId,
      `batch-${suffix}`,
    );
    assert.deepEqual(
      await service.createBatch(
        {
          source: "peter-rabbit-candidate",
          sourceCommitSha: "7b882b22bfcf535cf2677616cfa82b6bb3d8a70e",
          toolVersion: "ingestion-smoke/1.0.0",
          workId: "peter-rabbit",
          pieceId: "peter-rabbit-01",
          contentVersion: 1,
          items: declaredItems,
        },
        actorUserId,
        `batch-${suffix}`,
      ),
      batch,
    );

    for (const [index, file] of files.entries()) {
      const upload = await service.createUploadSession(
        { batchId: batch.batchId, clientFileId: file.clientFileId },
        `upload-${suffix}-${index}`,
      );
      assert.equal(upload.parts.length, 1);
      assert.match(upload.parts[0]!.uploadUrl, /^http/);
      const stored = await pool.query<{
        bucket: string;
        object_key: string;
        multipart_upload_id: string;
      }>(
        "SELECT bucket, object_key, multipart_upload_id FROM upload_sessions WHERE id = $1",
        [upload.uploadSessionId],
      );
      const size = (await stat(file.path)).size;
      const uploaded = await s3.send(
        new UploadPartCommand({
          Bucket: stored.rows[0]!.bucket,
          Key: stored.rows[0]!.object_key,
          UploadId: stored.rows[0]!.multipart_upload_id,
          PartNumber: 1,
          Body: createReadStream(file.path),
          ContentLength: size,
        }),
      );
      assert.ok(uploaded.ETag);
      await service.completeUploadSession(upload.uploadSessionId, [
        { partNumber: 1, etag: uploaded.ETag! },
      ]);
    }

    await queueEvents.waitUntilReady();
    await service.finalizeBatch(batch.batchId, `request-${suffix}`);
    const processingJobs = await pool.query<{ id: string }>(
      `SELECT j.id FROM processing_jobs j
       JOIN ingestion_items i ON i.id = j.ingestion_item_id
       WHERE i.batch_id = $1 ORDER BY j.id`,
      [batch.batchId],
    );
    assert.equal(processingJobs.rows.length, 7);
    for (const processingJob of processingJobs.rows) {
      const queuedJob = await queue.getJob(`ingestion-${processingJob.id}`);
      assert.ok(queuedJob);
      await queuedJob.waitUntilFinished(queueEvents, 120_000);
    }

    const completed = await service.getBatch(batch.batchId);
    assert.equal(completed.status, "ready_for_review");
    assert.equal(completed.items.every(({ status }) => status === "ready"), true);
    const candidate = await pool.query<{
      id: string;
      publishable: boolean;
      status: string;
      assets: string;
    }>(
      `SELECT cv.id, cv.publishable, cv.status,
              count(ca.id)::text AS assets
       FROM content_versions cv
       LEFT JOIN content_assets ca
         ON ca.piece_id = cv.piece_id AND ca.content_version = cv.content_version
       WHERE cv.piece_id = 'peter-rabbit-01' AND cv.content_version = 1
       GROUP BY cv.id`,
    );
    assert.equal(candidate.rows[0]?.publishable, false);
    assert.equal(candidate.rows[0]?.status, "ready_for_review");
    assert.equal(candidate.rows[0]?.assets, "7");
    await assert.rejects(
      service.publishContentVersion(
        candidate.rows[0]!.id,
        { reviewId: randomUUID(), expectedCurrentContentVersion: null },
        actorUserId,
        `publish-${suffix}`,
      ),
      (error: unknown) =>
        error instanceof ApiError && error.code === "PUBLISH_GATE_NOT_SATISFIED",
    );

    const sourceObjects = await pool.query<{
      client_file_id: string;
      bucket: string;
      object_key: string;
      expected_size_bytes: string;
      expected_sha256: string;
    }>(
      `SELECT i.client_file_id, us.bucket, us.object_key,
              i.expected_size_bytes, i.expected_sha256
       FROM ingestion_items i
       JOIN upload_sessions us ON us.ingestion_item_id = i.id AND us.status = 'completed'
       WHERE i.batch_id = $1 AND i.client_file_id IN ('audio', 'text')`,
      [batch.batchId],
    );

    const runFailureCase = async (
      contentVersion: number,
      sourceClientFileId: "audio" | "text",
      expectedSha256: string,
      expectedErrorCode: string,
    ) => {
      const source = sourceObjects.rows.find(
        ({ client_file_id }) => client_file_id === sourceClientFileId,
      )!;
      const failedBatchId = randomUUID();
      const failedItemId = randomUUID();
      const failedJobId = randomUUID();
      await pool.query(
        `INSERT INTO ingestion_batches (
           id, idempotency_key, request_hash, source, source_commit_sha, tool_version,
           operator_user_id, work_id, piece_id, content_version, status, total_count, finalized_at
         ) VALUES ($1, $2, $3, 'failure-smoke', '7b882b2', 'ingestion-smoke/1.0.0',
                   $4, 'peter-rabbit', 'peter-rabbit-01', $5, 'queued', 1, now())`,
        [failedBatchId, `failure-${suffix}-${contentVersion}`, "c".repeat(64), actorUserId, contentVersion],
      );
      await pool.query(
        `INSERT INTO ingestion_items (
           id, batch_id, client_file_id, asset_type, file_name,
           expected_size_bytes, expected_sha256, mime_type, status
         ) VALUES ($1, $2, $3, 'audio', 'failure.mp3', $4, $5, 'audio/mpeg', 'queued')`,
        [failedItemId, failedBatchId, `failure-${contentVersion}`, source.expected_size_bytes, expectedSha256],
      );
      await pool.query(
        `INSERT INTO upload_sessions (
           ingestion_item_id, idempotency_key, request_hash, bucket, object_key,
           multipart_upload_id, part_size_bytes, part_count,
           expected_size_bytes, expected_sha256, status, expires_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 8388608, 1, $7, $8,
                   'completed', now() + interval '1 hour', now())`,
        [
          failedItemId,
          `failure-upload-${suffix}-${contentVersion}`,
          "d".repeat(64),
          source.bucket,
          source.object_key,
          `failure-upload-${contentVersion}`,
          source.expected_size_bytes,
          expectedSha256,
        ],
      );
      await pool.query(
        `INSERT INTO processing_jobs (
           id, ingestion_item_id, job_type, idempotency_key
         ) VALUES ($1, $2, 'package_validate', $3)`,
        [failedJobId, failedItemId, `failure-job-${suffix}-${contentVersion}`],
      );
      await assert.rejects(
        processor.process(failedJobId, 1, 1),
        (error: unknown) =>
          error instanceof IngestionProcessingError && error.code === expectedErrorCode,
      );
      const failed = await pool.query<{ status: string; error_code: string }>(
        "SELECT status, error_code FROM ingestion_items WHERE id = $1",
        [failedItemId],
      );
      assert.deepEqual(failed.rows[0], { status: "failed", error_code: expectedErrorCode });
    };

    await runFailureCase(2, "audio", "0".repeat(64), "ASSET_CHECKSUM_MISMATCH");
    const textSource = sourceObjects.rows.find(({ client_file_id }) => client_file_id === "text")!;
    await runFailureCase(
      3,
      "text",
      textSource.expected_sha256.trim(),
      "INGESTION_JOB_FAILED",
    );
    process.stdout.write(
      `ingestion.smoke.passed batch=${batch.batchId} files=7 assets=7 publishable=false checksum=blocked corruptAudio=blocked\n`,
    );
  } finally {
    await worker.close();
    await queueEvents.close();
    await cleanupObjects().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    s3.destroy();
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
