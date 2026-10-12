import { createHash, randomUUID } from "node:crypto";

import {
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
import {BulkImportService} from "./bulk-service.ts";
import type {BulkPlan} from "./bulk-plan.ts";
import {UploadRecoveryService} from "./upload-recovery.ts";
import {IngestionOperationsService,type BatchListOptions} from "./operations-service.ts";

export type IngestionJobPayload = {
  type: "content.ingestion.item";
  processingJobId: string;
  requestId: string;
  dispatchGeneration?: number;
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
  private readonly cursorKeyBase64?:string;

  constructor(
    pool: Pool,
    s3: S3Client,
    queue: Queue<IngestionJobPayload>,
    incomingBucket: string,
    publishedBucket: string,
    cursorKeyBase64?:string,
  ) {
    this.pool = pool;
    this.s3 = s3;
    this.queue = queue;
    this.incomingBucket = incomingBucket;
    this.publishedBucket = publishedBucket;
    this.cursorKeyBase64=cursorKeyBase64;
  }

  // Match the catalog's first published chapter metadata; later chapters must not overwrite work fields.
  private async projectCatalog(client: PoolClient, pieceId: string, workId: string, metadata: Record<string, unknown>): Promise<void> {
    const level = typeof metadata.level === "string" && /^\d+(\.\d{1,2})?$/.test(metadata.level) && Number(metadata.level) <= 99.99 ? metadata.level : null;
    await client.query("UPDATE pieces SET word_count=$2,ranking_level=$3 WHERE id=$1", [pieceId, metadata.wordCount ?? null, level]);
    await client.query(`UPDATE works w SET status='published',author=m.value->>'author',series=m.value->>'series',ranking_category=m.value->>'category'
      FROM (SELECT cv.catalog_metadata AS value FROM pieces p
        JOIN content_versions cv ON cv.id=p.current_content_version_id AND cv.status='published'
        WHERE p.work_id=$1 AND p.status='published' ORDER BY p.sort_order,p.id LIMIT 1) m
      WHERE w.id=$1`, [workId]);
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

  async createImportGroup(plan:BulkPlan,actor:string,key:string,requestId:string){return new BulkImportService(this.pool).create(plan,actor,key,requestId);}
  async getImportGroup(id:string){return new BulkImportService(this.pool).get(id);}
  async listImportGroups(){return new BulkImportService(this.pool).list();}

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
      const previous = await client.query<{ id: string; request_hash: string; operator_user_id:string }>(
        "SELECT id, request_hash, operator_user_id FROM ingestion_batches WHERE idempotency_key = $1",
        [idempotencyKey],
      );
      if (previous.rows[0]) {
        const admin=await client.query("SELECT r.role FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=$1 AND u.status=\u0027active\u0027 AND r.role IN (\u0027content_admin\u0027,\u0027operations_admin\u0027) FOR SHARE OF u,r",[actorUserId]);
        if(!admin.rowCount)throw new ApiError("FORBIDDEN",403,false,"Active content administrator required");
        if (previous.rows[0].operator_user_id!==actorUserId||previous.rows[0].request_hash.trim() !== requestHash) {
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

      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["catalog-piece:"+input.pieceId]);
      const admin=await client.query("SELECT r.role FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=$1 AND u.status=\u0027active\u0027 AND r.role IN (\u0027content_admin\u0027,\u0027operations_admin\u0027) FOR SHARE OF u,r",[actorUserId]);
      if(!admin.rowCount)throw new ApiError("FORBIDDEN",403,false,"Active content administrator required");
      const piece = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pieces WHERE id = $1 AND work_id = $2
         ) AS exists`,
        [input.pieceId, input.workId],
      );
      if (!piece.rows[0]?.exists) {
        throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Work or piece does not exist");
      }

      if((await client.query("SELECT id FROM ingestion_batches WHERE piece_id=$1 AND content_version=$2 UNION ALL SELECT id FROM content_versions WHERE piece_id=$1 AND content_version=$2 LIMIT 1",[input.pieceId,input.contentVersion])).rowCount)throw new ApiError("INGESTION_BATCH_CONFLICT",409,false,"Chapter version has import history; use a new content version");
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
          JSON.stringify({ contractVersion: "api-contract-v2.9.0" }),
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

  async createUploadSession(input: { batchId: string; clientFileId: string }, idempotencyKey: string, actorUserId?: string) {
    const requestHash = hashRequest(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `upload-session:${idempotencyKey}`,
      ]);
      const batch = (await client.query<{status:string}>("SELECT status FROM ingestion_batches WHERE id=$1 FOR UPDATE", [input.batchId])).rows[0];
      if (!batch) throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Ingestion batch not found");
      if (!["draft","uploading"].includes(batch.status)) throw new ApiError("INGESTION_BATCH_CONFLICT",409,false,"Batch no longer accepts uploads");
      if (actorUserId) {
        const role=await client.query("SELECT r.role FROM users a JOIN user_roles r ON r.user_id=a.id WHERE a.id=$1 AND a.status='active' AND r.role IN ('content_admin','operations_admin') FOR SHARE OF a,r",[actorUserId]);
        if (!role.rowCount) throw new ApiError("FORBIDDEN",403,false,"Active content administrator required");
      }
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
        status: string;
      }>(
        `SELECT i.id, i.batch_id, i.file_name, i.expected_size_bytes,
                i.expected_sha256, i.mime_type, i.status, b.status AS batch_status
         FROM ingestion_items i
         JOIN ingestion_batches b ON b.id = i.batch_id
         WHERE i.batch_id = $1 AND i.client_file_id = $2
         FOR UPDATE OF i`,
        [input.batchId, input.clientFileId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Ingestion item not found");
      if (!['draft', 'uploading'].includes(item.batch_status)) {
        throw new ApiError("INGESTION_BATCH_CONFLICT", 409, false, "Batch no longer accepts uploads");
      }
      if(item.status!=="declared")throw new ApiError("INGESTION_BATCH_CONFLICT",409,false,"Item already has an upload; recover its existing session");

      const sizeBytes = Number(item.expected_size_bytes);
      const partCount = Math.ceil(sizeBytes / multipartPartSize);
      if (!Number.isSafeInteger(sizeBytes) || partCount < 1 || partCount > 10_000) {
        throw new ApiError("INVALID_REQUEST", 400, false, "File size cannot be represented as multipart upload");
      }
      const uploadSessionId = randomUUID();
      const objectKey = `incoming/${input.batchId}/${item.id}/${uploadSessionId}/${safeObjectName(item.file_name)}`;
      const created = await this.s3.send(
        new CreateMultipartUploadCommand({
          Bucket: this.incomingBucket,
          Key: objectKey,
          ContentType: item.mime_type,
          Metadata: {
            "expected-sha256": item.expected_sha256.trim(),
            "ingestion-item-id": item.id,
            "upload-session-id": uploadSessionId,
          },
        }),
      );
      if (!created.UploadId) throw new Error("Object storage did not return multipart upload ID");
      const expiresAt = new Date(Date.now() + uploadTtlSeconds * 1000);
      await client.query(
        `INSERT INTO upload_sessions (
           id, ingestion_item_id, idempotency_key, request_hash, bucket, object_key,
           multipart_upload_id, part_size_bytes, part_count,
           expected_size_bytes, expected_sha256, expires_at, storage_nonce
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $1)`,
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

  async completeUploadSession(uploadSessionId: string, parts: Array<{ partNumber: number; etag: string }>, actorUserId?:string, idempotencyKey?:string) {
    return new UploadRecoveryService(this.pool,this.s3).complete(uploadSessionId,parts,actorUserId,idempotencyKey);
  }

  async getUploadSession(id:string,actor:string){return new UploadRecoveryService(this.pool,this.s3).status(id,actor);}
  async renewUploadSession(id:string,actor:string,key:string){return new UploadRecoveryService(this.pool,this.s3).renew(id,actor,key);}

  async getBatchRecovery(batchId:string){
    const batch=await this.getBatch(batchId);
    const items=await this.pool.query(`SELECT i.id AS "itemId",i.client_file_id AS "clientFileId",i.asset_type AS "assetType",i.file_name AS "fileName",i.expected_size_bytes::float8 AS "sizeBytes",trim(i.expected_sha256) AS sha256,i.mime_type AS "mimeType",i.status,i.error_code AS "errorCode",u.id AS "uploadSessionId",j.id AS "jobId",j.status AS "jobStatus" FROM ingestion_items i LEFT JOIN LATERAL (SELECT id FROM upload_sessions WHERE ingestion_item_id=i.id ORDER BY created_at DESC,id DESC LIMIT 1) u ON true LEFT JOIN processing_jobs j ON j.ingestion_item_id=i.id AND j.job_type='package_validate' WHERE i.batch_id=$1 ORDER BY i.created_at,i.id`,[batchId]);
    const control=(await this.pool.query(`SELECT b.source,b.source_commit_sha AS "sourceCommitSha",EXISTS(SELECT 1 FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=b.id AND j.status='running') AS running,(SELECT count(*)::int FROM upload_sessions u JOIN ingestion_items i ON i.id=u.ingestion_item_id WHERE i.batch_id=b.id AND u.status='aborted' AND u.abort_confirmed_at IS NULL) AS "pendingUploadCleanup",cv.id AS "contentVersionId",cv.status AS "contentStatus",cv.publishable FROM ingestion_batches b LEFT JOIN content_versions cv ON cv.source_batch_id=b.id WHERE b.id=$1`,[batchId])).rows[0]!;
    const jobs=(await this.pool.query(`SELECT j.id,j.attempt_count,j.max_attempts,j.dispatch_generation FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=$1`,[batchId])).rows;
    const currentItems=items.rows.map(item=>{const job=jobs.find(row=>row.id===item.jobId);return{...item,attemptCount:job?.attempt_count??null,maxAttempts:job?.max_attempts??null,dispatchGeneration:job?.dispatch_generation??null,canRetry:!!job&&["failed","dead_letter"].includes(item.jobStatus)&&job.attempt_count<job.max_attempts&&["queued","processing","partial_failed"].includes(batch.status)};});
    return{batchId:batch.batchId,status:batch.status,workId:batch.workId,pieceId:batch.pieceId,contentVersion:batch.contentVersion,items:currentItems,source:control.source,sourceCommitSha:control.sourceCommitSha,canCancel:!control.running&&(["draft","uploading","queued","partial_failed"].includes(batch.status)||batch.status==="cancelled"&&control.pendingUploadCleanup>0),pendingUploadCleanup:control.pendingUploadCleanup,content:control.contentVersionId?{contentVersionId:control.contentVersionId,status:control.contentStatus,publishable:control.publishable}:null};
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
      if (!["draft","uploading","queued","processing","partial_failed","ready_for_review","published"].includes(batch.rows[0].status))throw new ApiError("INGESTION_BATCH_CONFLICT",409,false,"Batch cannot be finalized in its current state");
      const incomplete = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ingestion_items WHERE batch_id = $1 AND status <> 'uploaded'",
        [batchId],
      );
      if (incomplete.rows[0]?.count !== "0" && ["draft","uploading"].includes(batch.rows[0].status)) {
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

  private operations(){return new IngestionOperationsService(this.pool,this.s3,this.queue,this.cursorKeyBase64);}
  async listBatches(actor:string,options:BatchListOptions){return this.operations().list(actor,options);}
  async getJob(id:string){return this.operations().job(id);}
  async cancelBatch(id:string,actor:string,key:string,requestId:string){return this.operations().cancel(id,actor,key,requestId);}
  async retryJob(id:string,requestId:string,actor:string,key:string){return this.operations().retry(id,actor,key,requestId);}

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
        work_id: string;
        catalog_metadata: Record<string, unknown>;
        current_content_version: number | null;
      }>(
        `SELECT cv.id, cv.piece_id, p.work_id, cv.content_version, cv.status, cv.publishable, cv.catalog_metadata,
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

      const workStatus = (await client.query<{status:string}>("SELECT status FROM works WHERE id=$1 FOR UPDATE", [version.work_id])).rows[0]?.status;
      if (workStatus === "archived" || !workStatus || Object.keys(version.catalog_metadata).length === 0) throw new ApiError("PUBLISH_GATE_NOT_SATISFIED",409,false,"An active work and validated catalog metadata are required");
      const assets = await client.query<{
        id: string;
        asset_type: string;
        bucket: string;
        object_key: string;
        status: string;
      }>(
        "SELECT id, asset_type, bucket, object_key, status FROM content_assets WHERE piece_id = $1 AND content_version = $2 FOR UPDATE",
        [version.piece_id, version.content_version],
      );
      if (assets.rows.length !== 7 || assets.rows.some(asset=>asset.status !== "ready") || new Set(assets.rows.map(asset=>asset.asset_type)).size !== 7) {
        throw new ApiError("CONFLICT", 409, false, "Content version requires all seven validated ready assets");
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
      await this.projectCatalog(client,version.piece_id,version.work_id,version.catalog_metadata);
      await client.query("UPDATE quiz_packages SET status='published',published_at=now() WHERE piece_id=$1 AND content_version=$2 AND status='draft'", [version.piece_id,version.content_version]);
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
      const source = await client.query<{ piece_id: string; work_id: string }>(
        `SELECT cv.piece_id, p.work_id FROM content_versions cv
         JOIN pieces p ON p.current_content_version_id = cv.id
         WHERE cv.id = $1 FOR UPDATE OF cv, p`,
        [contentVersionId],
      );
      if (!source.rows[0]) {
        throw new ApiError("CONFLICT", 409, false, "Source content version is not currently published");
      }
      const target = await client.query<{ id: string; publishable: boolean; status: string; catalog_metadata: Record<string,unknown> }>(
        `SELECT id, publishable, status, catalog_metadata FROM content_versions
         WHERE piece_id = $1 AND content_version = $2 FOR UPDATE`,
        [source.rows[0].piece_id, input.targetContentVersion],
      );
      if (!target.rows[0] || !target.rows[0].publishable || !['published', 'superseded'].includes(target.rows[0].status)) {
        throw new ApiError("PUBLISH_GATE_NOT_SATISFIED", 409, false, "Rollback target is not an approved published version");
      }
      const workStatus = (await client.query<{status:string}>("SELECT status FROM works WHERE id=$1 FOR UPDATE",[source.rows[0].work_id])).rows[0]?.status;
      const resources = (await client.query<{assets:string; quizzes:string}>(`SELECT
        (SELECT count(*)::text FROM content_assets WHERE piece_id=$1 AND content_version=$2 AND status='published') AS assets,
        (SELECT count(*)::text FROM quiz_packages WHERE piece_id=$1 AND content_version=$2 AND status='published') AS quizzes`,[source.rows[0].piece_id,input.targetContentVersion])).rows[0]!;
      if(target.rows[0].id===contentVersionId||workStatus==='archived'||resources.assets!=='7'||resources.quizzes==='0'||Object.keys(target.rows[0].catalog_metadata).length===0)throw new ApiError("PUBLISH_GATE_NOT_SATISFIED",409,false,"Rollback requires a different complete approved version and active work");
      await client.query("UPDATE content_versions SET status = 'superseded' WHERE id = $1", [contentVersionId]);
      await client.query("UPDATE content_versions SET status = 'published', published_at = now(), rollback_from_id = $1 WHERE id = $2", [
        contentVersionId,
        target.rows[0].id,
      ]);
      await client.query("UPDATE pieces SET current_content_version_id = $1 WHERE id = $2", [
        target.rows[0].id,
        source.rows[0].piece_id,
      ]);
      await this.projectCatalog(client,source.rows[0].piece_id,source.rows[0].work_id,target.rows[0].catalog_metadata);
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
