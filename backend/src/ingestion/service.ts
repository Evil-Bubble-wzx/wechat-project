import { createHash, randomUUID } from "node:crypto";

import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Queue } from "bullmq";
import type { Pool, PoolClient } from "pg";

import { ApiError } from "../api/errors.ts";

export type IngestionJobPayload = {
  type: "content.ingestion.item";
  processingJobId: string;
  requestId: string;
};

export type IngestionItemInput = {
  clientFileId: string;
  assetType: "audio" | "subtitles" | "text" | "vocabulary" | "quiz" | "cover" | "metadata";
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
};

export type CreateBatchInput = {
  source: string;
  sourceCommitSha: string;
  toolVersion: string;
  workId: string;
  pieceId: string;
  contentVersion: number;
  items: IngestionItemInput[];
};

export type BatchResponse = {
  batchId: string;
  workId: string;
  pieceId: string;
  contentVersion: number;
  status: string;
  items: Array<{
    itemId: string;
    clientFileId: string;
    status: string;
    errorCode: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
};

type BatchRow = {
  id: string;
  work_id: string;
  piece_id: string;
  content_version: number;
  status: string;
  created_at: Date;
  updated_at: Date;
  request_hash: string;
};

type ItemRow = {
  id: string;
  client_file_id: string;
  status: string;
  error_code: string | null;
};

type UploadRow = {
  id: string;
  request_hash: string;
  bucket: string;
  object_key: string;
  multipart_upload_id: string;
  part_size_bytes: number;
  part_count: number;
  expires_at: Date;
  status: string;
};

const multipartPartSize = 8 * 1024 * 1024;
const uploadTtlSeconds = 15 * 60;

function hashRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeObjectName(fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
  return safe || "asset.bin";
}

export class IngestionService {
  private readonly pool: Pool;
  private readonly s3: S3Client;
  private readonly queue: Queue<IngestionJobPayload>;
  private readonly incomingBucket: string;
  private readonly publishedBucket: string;

  constructor(
    pool: Pool,
    s3: S3Client,
    queue: Queue<IngestionJobPayload>,
    incomingBucket: string,
    publishedBucket: string,
  ) {
    this.pool = pool;
    this.s3 = s3;
    this.queue = queue;
    this.incomingBucket = incomingBucket;
    this.publishedBucket = publishedBucket;
  }

  private async getBatchWithClient(client: PoolClient, batchId: string): Promise<BatchResponse> {
    const batchResult = await client.query<BatchRow>(
      `SELECT id, work_id, piece_id, content_version, status, created_at, updated_at, request_hash
       FROM ingestion_batches WHERE id = $1`,
      [batchId],
    );
    const batch = batchResult.rows[0];
    if (!batch) throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Ingestion batch not found");
    const items = await client.query<ItemRow>(
      `SELECT id, client_file_id, status, error_code
       FROM ingestion_items WHERE batch_id = $1 ORDER BY created_at, id`,
      [batchId],
    );
    return {
      batchId: batch.id,
      workId: batch.work_id,
      pieceId: batch.piece_id,
      contentVersion: batch.content_version,
      status: batch.status,
      items: items.rows.map((item) => ({
        itemId: item.id,
        clientFileId: item.client_file_id,
        status: item.status,
        errorCode: item.error_code,
      })),
      createdAt: batch.created_at.toISOString(),
      updatedAt: batch.updated_at.toISOString(),
    };
  }

  async createBatch(input: CreateBatchInput, actorUserId: string, idempotencyKey: string): Promise<BatchResponse> {
    const assetTypes = input.items.map(({ assetType }) => assetType);
    const requiredTypes = ["audio", "subtitles", "text", "vocabulary", "quiz", "cover", "metadata"];
    if (
      new Set(assetTypes).size !== assetTypes.length ||
      requiredTypes.some((assetType) => !assetTypes.includes(assetType as IngestionItemInput["assetType"]))
    ) {
      throw new ApiError(
        "INVALID_REQUEST",
        400,
        false,
        "A content version requires exactly one declaration for each required asset type",
      );
    }
    const requestHash = hashRequest(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `ingestion-batch:${idempotencyKey}`,
      ]);
      const previous = await client.query<{ id: string; request_hash: string }>(
        "SELECT id, request_hash FROM ingestion_batches WHERE idempotency_key = $1",
        [idempotencyKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash.trim() !== requestHash) {
          throw new ApiError(
            "IDEMPOTENCY_KEY_REUSED",
            409,
            false,
            "Idempotency key was used with another batch declaration",
          );
        }
        const response = await this.getBatchWithClient(client, previous.rows[0].id);
        await client.query("COMMIT");
        return response;
      }

      const piece = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pieces WHERE id = $1 AND work_id = $2
         ) AS exists`,
        [input.pieceId, input.workId],
      );
      if (!piece.rows[0]?.exists) {
        throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Work or piece does not exist");
      }

      const batchId = randomUUID();
      await client.query(
        `INSERT INTO ingestion_batches (
           id, idempotency_key, request_hash, source, source_commit_sha, tool_version,
           operator_user_id, work_id, piece_id, content_version, total_count, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          batchId,
          idempotencyKey,
          requestHash,
          input.source,
          input.sourceCommitSha,
          input.toolVersion,
          actorUserId,
          input.workId,
          input.pieceId,
          input.contentVersion,
          input.items.length,
          JSON.stringify({ contractVersion: "api-contract-v1.0.0" }),
        ],
      );
      for (const item of input.items) {
        await client.query(
          `INSERT INTO ingestion_items (
             batch_id, client_file_id, asset_type, file_name,
             expected_size_bytes, expected_sha256, mime_type
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            batchId,
            item.clientFileId,
            item.assetType,
            item.fileName,
            item.sizeBytes,
            item.sha256,
            item.mimeType,
          ],
        );
      }
      const response = await this.getBatchWithClient(client, batchId);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof ApiError) throw error;
      const databaseError = error as { constraint?: string };
      if (databaseError.constraint === "ingestion_batches_active_piece_version_uidx") {
        throw new ApiError(
          "INGESTION_BATCH_CONFLICT",
          409,
          false,
          "An active ingestion already exists for this piece version",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getBatch(batchId: string): Promise<BatchResponse> {
    const client = await this.pool.connect();
    try {
      return await this.getBatchWithClient(client, batchId);
    } finally {
      client.release();
    }
  }

  private async signParts(upload: UploadRow) {
    const expiresIn = Math.max(
      1,
      Math.min(uploadTtlSeconds, Math.floor((upload.expires_at.getTime() - Date.now()) / 1000)),
    );
    const parts = [];
    for (let partNumber = 1; partNumber <= upload.part_count; partNumber += 1) {
      const uploadUrl = await getSignedUrl(
        this.s3,
        new UploadPartCommand({
          Bucket: upload.bucket,
          Key: upload.object_key,
          UploadId: upload.multipart_upload_id,
          PartNumber: partNumber,
        }),
        { expiresIn },
      );
      parts.push({ partNumber, uploadUrl });
    }
    return {
      uploadSessionId: upload.id,
      objectKey: upload.object_key,
      partSizeBytes: upload.part_size_bytes,
      expiresAt: upload.expires_at.toISOString(),
      parts,
    };
  }

  async createUploadSession(input: { batchId: string; clientFileId: string }, idempotencyKey: string) {
    const requestHash = hashRequest(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `upload-session:${idempotencyKey}`,
      ]);
      const existing = await client.query<UploadRow>(
        `SELECT id, request_hash, bucket, object_key, multipart_upload_id,
                part_size_bytes, part_count, expires_at, status
         FROM upload_sessions WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash.trim() !== requestHash) {
          throw new ApiError(
            "IDEMPOTENCY_KEY_REUSED",
            409,
            false,
            "Idempotency key was used for another upload session",
          );
        }
        if (existing.rows[0].status !== "active" || existing.rows[0].expires_at <= new Date()) {
          throw new ApiError("UPLOAD_SESSION_EXPIRED", 410, false, "Upload session has expired");
        }
        await client.query("COMMIT");
        return this.signParts(existing.rows[0]);
      }

      const itemResult = await client.query<{
        id: string;
        batch_id: string;
        file_name: string;
        expected_size_bytes: string;
        expected_sha256: string;
        mime_type: string;
        batch_status: string;
      }>(
        `SELECT i.id, i.batch_id, i.file_name, i.expected_size_bytes,
                i.expected_sha256, i.mime_type, b.status AS batch_status
         FROM ingestion_items i
         JOIN ingestion_batches b ON b.id = i.batch_id
         WHERE i.batch_id = $1 AND i.client_file_id = $2
         FOR UPDATE OF i, b`,
        [input.batchId, input.clientFileId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Ingestion item not found");
      if (!['draft', 'uploading'].includes(item.batch_status)) {
        throw new ApiError("INGESTION_BATCH_CONFLICT", 409, false, "Batch no longer accepts uploads");
      }

      const sizeBytes = Number(item.expected_size_bytes);
      const partCount = Math.ceil(sizeBytes / multipartPartSize);
      if (!Number.isSafeInteger(sizeBytes) || partCount < 1 || partCount > 10_000) {
        throw new ApiError("INVALID_REQUEST", 400, false, "File size cannot be represented as multipart upload");
      }
      const uploadSessionId = randomUUID();
      const objectKey = `incoming/${input.batchId}/${item.id}/${safeObjectName(item.file_name)}`;
      const created = await this.s3.send(
        new CreateMultipartUploadCommand({
          Bucket: this.incomingBucket,
          Key: objectKey,
          ContentType: item.mime_type,
          Metadata: {
            "expected-sha256": item.expected_sha256.trim(),
            "ingestion-item-id": item.id,
          },
        }),
      );
      if (!created.UploadId) throw new Error("Object storage did not return multipart upload ID");
      const expiresAt = new Date(Date.now() + uploadTtlSeconds * 1000);
      await client.query(
        `INSERT INTO upload_sessions (
           id, ingestion_item_id, idempotency_key, request_hash, bucket, object_key,
           multipart_upload_id, part_size_bytes, part_count,
           expected_size_bytes, expected_sha256, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          uploadSessionId,
          item.id,
          idempotencyKey,
          requestHash,
          this.incomingBucket,
          objectKey,
          created.UploadId,
          multipartPartSize,
          partCount,
          sizeBytes,
          item.expected_sha256.trim(),
          expiresAt,
        ],
      );
      await client.query("UPDATE ingestion_items SET status = 'uploading' WHERE id = $1", [item.id]);
      await client.query("UPDATE ingestion_batches SET status = 'uploading' WHERE id = $1", [input.batchId]);
      await client.query("COMMIT");
      return this.signParts({
        id: uploadSessionId,
        request_hash: requestHash,
        bucket: this.incomingBucket,
        object_key: objectKey,
        multipart_upload_id: created.UploadId,
        part_size_bytes: multipartPartSize,
        part_count: partCount,
        expires_at: expiresAt,
        status: "active",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeUploadSession(uploadSessionId: string, parts: Array<{ partNumber: number; etag: string }>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<
        UploadRow & { ingestion_item_id: string; expected_size_bytes: string }
      >(
        `SELECT id, request_hash, bucket, object_key, multipart_upload_id,
                part_size_bytes, part_count, expires_at, status,
                ingestion_item_id, expected_size_bytes
         FROM upload_sessions WHERE id = $1 FOR UPDATE`,
        [uploadSessionId],
      );
      const upload = result.rows[0];
      if (!upload) throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Upload session not found");
      if (upload.status === "completed") {
        await client.query("COMMIT");
        return { status: "completed" as const, resourceId: upload.id };
      }
      if (upload.status !== "active" || upload.expires_at <= new Date()) {
        throw new ApiError("UPLOAD_SESSION_EXPIRED", 410, false, "Upload session has expired");
      }
      if (parts.length !== upload.part_count) {
        throw new ApiError("INVALID_REQUEST", 400, false, "Completed part list is incomplete");
      }
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: upload.bucket,
          Key: upload.object_key,
          UploadId: upload.multipart_upload_id,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
          },
        }),
      );
      const head = await this.s3.send(
        new HeadObjectCommand({ Bucket: upload.bucket, Key: upload.object_key }),
      );
      if (head.ContentLength !== Number(upload.expected_size_bytes)) {
        throw new ApiError(
          "ASSET_CHECKSUM_MISMATCH",
          422,
          false,
          "Uploaded object size differs from the declaration",
        );
      }
      await client.query(
        "UPDATE upload_sessions SET status = 'completed', completed_at = now() WHERE id = $1",
        [upload.id],
      );
      await client.query(
        "UPDATE ingestion_items SET status = 'uploaded' WHERE id = $1",
        [upload.ingestion_item_id],
      );
      await client.query("COMMIT");
      return { status: "completed" as const, resourceId: upload.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeBatch(batchId: string, requestId: string) {
    const client = await this.pool.connect();
    let jobs: Array<{ id: string }> = [];
    try {
      await client.query("BEGIN");
      const batch = await client.query<{ status: string }>(
        "SELECT status FROM ingestion_batches WHERE id = $1 FOR UPDATE",
        [batchId],
      );
      if (!batch.rows[0]) throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Batch not found");
      const incomplete = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ingestion_items WHERE batch_id = $1 AND status <> 'uploaded'",
        [batchId],
      );
      if (incomplete.rows[0]?.count !== "0" && batch.rows[0].status === "uploading") {
        throw new ApiError("INGESTION_BATCH_CONFLICT", 409, false, "Not all declared files are uploaded");
      }
      await client.query(
        `INSERT INTO processing_jobs (ingestion_item_id, job_type, idempotency_key)
         SELECT id, 'package_validate', 'ingestion-item:' || id::text
         FROM ingestion_items WHERE batch_id = $1
         ON CONFLICT (job_type, idempotency_key) DO NOTHING`,
        [batchId],
      );
      jobs = (
        await client.query<{ id: string }>(
          `SELECT j.id FROM processing_jobs j
           JOIN ingestion_items i ON i.id = j.ingestion_item_id
           WHERE i.batch_id = $1 AND j.status IN ('queued', 'retry_wait')`,
          [batchId],
        )
      ).rows;
      await client.query(
        "UPDATE ingestion_items SET status = 'queued' WHERE batch_id = $1 AND status = 'uploaded'",
        [batchId],
      );
      await client.query(
        "UPDATE ingestion_batches SET status = 'queued', finalized_at = COALESCE(finalized_at, now()) WHERE id = $1 AND status IN ('uploading', 'queued')",
        [batchId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    for (const job of jobs) {
      await this.queue.add(
        "content.ingestion.item",
        { type: "content.ingestion.item", processingJobId: job.id, requestId },
        {
          jobId: `ingestion-${job.id}`,
          attempts: 5,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );
    }
    return { status: "accepted" as const, resourceId: batchId };
  }

  async cancelBatch(batchId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        `UPDATE ingestion_batches
         SET status = 'cancelled', cancelled_at = now()
         WHERE id = $1 AND status IN ('draft', 'uploading', 'queued', 'partial_failed')
         RETURNING id`,
        [batchId],
      );
      if (!result.rows[0]) {
        throw new ApiError("INGESTION_BATCH_CONFLICT", 409, false, "Batch cannot be cancelled in its current state");
      }
      await client.query(
        "UPDATE ingestion_items SET status = 'cancelled' WHERE batch_id = $1 AND status IN ('declared', 'uploading', 'uploaded', 'queued')",
        [batchId],
      );
      await client.query(
        `UPDATE processing_jobs SET status = 'cancelled', finished_at = now()
         WHERE ingestion_item_id IN (SELECT id FROM ingestion_items WHERE batch_id = $1)
           AND status IN ('queued', 'retry_wait')`,
        [batchId],
      );
      await client.query("COMMIT");
      return { status: "cancelled" as const, resourceId: batchId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async retryJob(jobId: string, requestId: string) {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE processing_jobs
       SET status = 'queued', error_code = NULL, error_summary = NULL,
           next_retry_at = NULL, finished_at = NULL
       WHERE id = $1 AND status IN ('failed', 'dead_letter') AND attempt_count < max_attempts
       RETURNING id`,
      [jobId],
    );
    if (!result.rows[0]) {
      throw new ApiError("INGESTION_JOB_FAILED", 409, false, "Job is not retryable");
    }
    await this.pool.query(
      `UPDATE ingestion_items SET status = 'queued', error_code = NULL, error_summary = NULL
       WHERE id = (SELECT ingestion_item_id FROM processing_jobs WHERE id = $1)`,
      [jobId],
    );
    const existing = await this.queue.getJob(`ingestion-${jobId}`);
    if (existing) await existing.remove();
    await this.queue.add(
      "content.ingestion.item",
      { type: "content.ingestion.item", processingJobId: jobId, requestId },
      {
        jobId: `ingestion-${jobId}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
    return { status: "accepted" as const, resourceId: jobId };
  }

  async publishContentVersion(
    contentVersionId: string,
    input: { reviewId: string; expectedCurrentContentVersion: number | null },
    actorUserId: string,
    requestId: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const versionResult = await client.query<{
        id: string;
        piece_id: string;
        content_version: number;
        status: string;
        publishable: boolean;
        current_content_version: number | null;
      }>(
        `SELECT cv.id, cv.piece_id, cv.content_version, cv.status, cv.publishable,
                current_cv.content_version AS current_content_version
         FROM content_versions cv
         JOIN pieces p ON p.id = cv.piece_id
         LEFT JOIN content_versions current_cv ON current_cv.id = p.current_content_version_id
         WHERE cv.id = $1
         FOR UPDATE OF cv, p`,
        [contentVersionId],
      );
      const version = versionResult.rows[0];
      if (!version) throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Content version not found");
      if (
        version.current_content_version !== input.expectedCurrentContentVersion ||
        version.status !== "ready_for_review"
      ) {
        throw new ApiError("CONFLICT", 409, false, "Published content version changed or candidate is not ready");
      }
      if (!version.publishable) {
        throw new ApiError(
          "PUBLISH_GATE_NOT_SATISFIED",
          409,
          false,
          "Content version is explicitly marked publishable=false",
        );
      }
      const gates = await client.query<{ gate_key: string }>(
        `SELECT gate_key FROM content_reviews
         WHERE content_version_id = $1 AND decision = 'approved'
           AND gate_key IN ('C-03', 'C-05')`,
        [contentVersionId],
      );
      const approvedGates = new Set(gates.rows.map(({ gate_key }) => gate_key));
      const review = await client.query<{ approved: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM content_reviews
           WHERE id = $1 AND content_version_id = $2 AND decision = 'approved'
         ) AS approved`,
        [input.reviewId, contentVersionId],
      );
      if (!review.rows[0]?.approved || !approvedGates.has("C-03") || !approvedGates.has("C-05")) {
        throw new ApiError(
          "PUBLISH_GATE_NOT_SATISFIED",
          409,
          false,
          "C-03 and C-05 approval gates are required",
        );
      }

      const assets = await client.query<{
        id: string;
        asset_type: string;
        bucket: string;
        object_key: string;
      }>(
        "SELECT id, asset_type, bucket, object_key FROM content_assets WHERE piece_id = $1 AND content_version = $2 FOR UPDATE",
        [version.piece_id, version.content_version],
      );
      if (assets.rows.length === 0) {
        throw new ApiError("CONFLICT", 409, false, "Content version has no validated assets");
      }
      const publishedObjects: Array<{ id: string; objectKey: string }> = [];
      for (const asset of assets.rows) {
        const fileName = asset.object_key.split("/").at(-1) ?? `${asset.asset_type}.bin`;
        const objectKey = `published/${version.piece_id}/v${version.content_version}/${asset.asset_type}/${fileName}`;
        const copySource = encodeURIComponent(`${asset.bucket}/${asset.object_key}`).replace(/%2F/g, "/");
        await this.s3.send(
          new CopyObjectCommand({
            Bucket: this.publishedBucket,
            Key: objectKey,
            CopySource: copySource,
          }),
        );
        publishedObjects.push({ id: asset.id, objectKey });
      }
      for (const asset of publishedObjects) {
        await client.query(
          `UPDATE content_assets
           SET bucket = $1, object_key = $2, status = 'published'
           WHERE id = $3`,
          [this.publishedBucket, asset.objectKey, asset.id],
        );
      }
      await client.query(
        `UPDATE content_versions SET status = 'superseded'
         WHERE piece_id = $1 AND status = 'published'`,
        [version.piece_id],
      );
      await client.query(
        "UPDATE content_versions SET status = 'published', published_at = now() WHERE id = $1",
        [contentVersionId],
      );
      await client.query("UPDATE pieces SET current_content_version_id = $1, status = 'published' WHERE id = $2", [
        contentVersionId,
        version.piece_id,
      ]);
      await client.query(
        `INSERT INTO audit_events (
           actor_type, actor_id, action, target_type, target_id, request_id, after_state
         ) VALUES ('admin', $1, 'content_version_publish', 'content_version', $2, $3, $4)`,
        [
          actorUserId,
          contentVersionId,
          requestId,
          JSON.stringify({ contentVersion: version.content_version }),
        ],
      );
      await client.query("COMMIT");
      return { status: "published" as const, resourceId: contentVersionId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rollbackContentVersion(
    contentVersionId: string,
    input: { targetContentVersion: number; reason: string },
    actorUserId: string,
    requestId: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const source = await client.query<{ piece_id: string }>(
        `SELECT cv.piece_id FROM content_versions cv
         JOIN pieces p ON p.current_content_version_id = cv.id
         WHERE cv.id = $1 FOR UPDATE OF cv, p`,
        [contentVersionId],
      );
      if (!source.rows[0]) {
        throw new ApiError("CONFLICT", 409, false, "Source content version is not currently published");
      }
      const target = await client.query<{ id: string; publishable: boolean; status: string }>(
        `SELECT id, publishable, status FROM content_versions
         WHERE piece_id = $1 AND content_version = $2 FOR UPDATE`,
        [source.rows[0].piece_id, input.targetContentVersion],
      );
      if (!target.rows[0] || !target.rows[0].publishable || !['published', 'superseded'].includes(target.rows[0].status)) {
        throw new ApiError("PUBLISH_GATE_NOT_SATISFIED", 409, false, "Rollback target is not an approved published version");
      }
      await client.query("UPDATE content_versions SET status = 'superseded' WHERE id = $1", [contentVersionId]);
      await client.query("UPDATE content_versions SET status = 'published', published_at = now(), rollback_from_id = $1 WHERE id = $2", [
        contentVersionId,
        target.rows[0].id,
      ]);
      await client.query("UPDATE pieces SET current_content_version_id = $1 WHERE id = $2", [
        target.rows[0].id,
        source.rows[0].piece_id,
      ]);
      await client.query(
        `INSERT INTO audit_events (
           actor_type, actor_id, action, target_type, target_id, request_id, before_state, after_state, metadata
         ) VALUES ('admin', $1, 'content_version_rollback', 'content_version', $2, $3, $4, $5, $6)`,
        [
          actorUserId,
          target.rows[0].id,
          requestId,
          JSON.stringify({ contentVersionId }),
          JSON.stringify({ targetContentVersion: input.targetContentVersion }),
          JSON.stringify({ reason: input.reason }),
        ],
      );
      await client.query("COMMIT");
      return { status: "rolled_back" as const, resourceId: target.rows[0].id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
