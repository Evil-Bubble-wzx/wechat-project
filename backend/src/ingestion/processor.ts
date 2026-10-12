import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import {
  CopyObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { Pool, PoolClient } from "pg";
import { validateCatalogMetadata, validateQuizPackage, validateVocabularyPackage, validateSubtitleReferences, type ValidatedQuiz } from "../content/package-validation.ts";
import { normalizeTimedSubtitles, timedSubtitleFormat, SubtitleNormalizationError, normalizedSubtitleLimit, timedSubtitleConverterVersion } from "./timed-subtitles.ts";

const execFileAsync = promisify(execFile);

type ProcessingRow = {
  job_id: string;
  job_status: string;
  batch_status:string;
  dispatch_generation:number;
  attempt_count: number;
  max_attempts: number;
  item_id: string;
  batch_id: string;
  asset_type: string;
  file_name: string;
  mime_type: string;
  expected_size_bytes: string;
  expected_sha256: string;
  bucket: string;
  object_key: string;
  work_id: string;
  piece_id: string;
  content_version: number;
  source: string;
  source_commit_sha: string | null;
  tool_version: string | null;
};

export class IngestionProcessingError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean, message: string) {
    super(message);
    this.name = "IngestionProcessingError";
    this.code = code;
    this.retryable = retryable;
  }
}

function copySource(bucket: string, objectKey: string): string {
  return encodeURIComponent(`${bucket}/${objectKey}`).replace(/%2F/g, "/");
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new IngestionProcessingError(
      "SUBTITLE_VALIDATION_FAILED",
      false,
      "Text asset is not valid UTF-8",
    );
  }
}

export function assertReaderAssetDeclaration(type: string, mime: string, name: string, size: number): void {
  if (!["metadata", "quiz", "vocabulary", "subtitles"].includes(type)) return;
  const raw = type === "subtitles" && timedSubtitleFormat(mime, name);
  const limit = raw ? 100 * 1024 * 1024 : normalizedSubtitleLimit;
  if (!Number.isSafeInteger(size) || size < 1 || size > limit || (!raw && mime !== "application/json")) {
    throw new IngestionProcessingError("INGESTION_JOB_FAILED", false, "Reader JSON requires application/json and at most 8 MiB; timed subtitles require VTT/SRT and at most 100 MiB");
  }
}

export function validateSubtitleJson(value: unknown): { cueCount: number; lastEndMs: number } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IngestionProcessingError(
      "SUBTITLE_VALIDATION_FAILED",
      false,
      "Subtitle JSON must be a non-empty cue array",
    );
  }
  let previousStart = -1;
  let previousEnd = -1;
  const ids = new Set<string>();
  for (const unknownCue of value) {
    if (!unknownCue || typeof unknownCue !== "object" || Array.isArray(unknownCue)) {
      throw new IngestionProcessingError("SUBTITLE_VALIDATION_FAILED", false, "Cue must be an object");
    }
    const cue = unknownCue as Record<string, unknown>;
    if (
      typeof cue.id !== "string" ||
      ids.has(cue.id) ||
      !Number.isInteger(cue.startMs) ||
      !Number.isInteger(cue.endMs) ||
      Number(cue.startMs) < 0 ||
      Number(cue.endMs) <= Number(cue.startMs) ||
      typeof cue.text !== "string" ||
      cue.text.length === 0
    ) {
      throw new IngestionProcessingError("SUBTITLE_VALIDATION_FAILED", false, "Cue fields are invalid");
    }
    if (Number(cue.startMs) < previousStart || Number(cue.startMs) < previousEnd) {
      throw new IngestionProcessingError(
        "SUBTITLE_VALIDATION_FAILED",
        false,
        "Cue timestamps are out of order or overlap",
      );
    }
    ids.add(cue.id);
    previousStart = Number(cue.startMs);
    previousEnd = Number(cue.endMs);
  }
  return { cueCount: value.length, lastEndMs: previousEnd };
}

export class IngestionProcessor {
  private readonly pool: Pool;
  private readonly s3: S3Client;
  private readonly ffprobePath: string;
  private readonly temporaryRoot:string;

  constructor(pool: Pool, s3: S3Client, ffprobePath: string, temporaryRoot=tmpdir()) {
    this.pool = pool;
    this.s3 = s3;
    this.ffprobePath = ffprobePath;
    this.temporaryRoot=temporaryRoot;
  }

  private async readJob(client: PoolClient, processingJobId: string): Promise<ProcessingRow> {
    const result = await client.query<ProcessingRow>(
      `SELECT j.id AS job_id, j.status AS job_status, j.attempt_count, j.max_attempts, j.dispatch_generation, b.status AS batch_status,
              i.id AS item_id, i.batch_id, i.asset_type, i.file_name, i.mime_type,
              i.expected_size_bytes, i.expected_sha256,
              us.bucket, us.object_key,
              b.work_id, b.piece_id, b.content_version, b.source,
              b.source_commit_sha, b.tool_version
       FROM processing_jobs j
       JOIN ingestion_items i ON i.id = j.ingestion_item_id
       JOIN ingestion_batches b ON b.id = i.batch_id
       JOIN LATERAL (
         SELECT bucket, object_key FROM upload_sessions
         WHERE ingestion_item_id = i.id AND status = 'completed'
         ORDER BY completed_at DESC LIMIT 1
       ) us ON true
       WHERE j.id = $1`,
      [processingJobId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new IngestionProcessingError("INGESTION_JOB_FAILED", false, "Processing job is missing or has no completed upload");
    }
    return row;
  }

  private async streamObjectToFile(row: ProcessingRow, filePath: string) {
    let response;
    try {
      response = await this.s3.send(
        new GetObjectCommand({ Bucket: row.bucket, Key: row.object_key }),
      );
    } catch {
      throw new IngestionProcessingError("DEPENDENCY_UNAVAILABLE", true, "Object storage read failed");
    }
    if (!response.Body) {
      throw new IngestionProcessingError("INGESTION_JOB_FAILED", true, "Object storage returned no body");
    }
    const digest = createHash("sha256");
    const output = createWriteStream(filePath, { flags: "wx" });
    let sizeBytes = 0;
    try {
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        sizeBytes += buffer.length;
        if (sizeBytes > Number(row.expected_size_bytes)) {
          throw new IngestionProcessingError(
            "ASSET_CHECKSUM_MISMATCH",
            false,
            "Object is larger than declared",
          );
        }
        digest.update(buffer);
        if (!output.write(buffer)) {
          await new Promise<void>((resolve) => output.once("drain", resolve));
        }
      }
      await new Promise<void>((resolve, reject) => {
        output.end(resolve);
        output.once("error", reject);
      });
    } catch (error) {
      output.destroy();
      throw error;
    }
    const actualSha256 = digest.digest("hex");
    if (
      sizeBytes !== Number(row.expected_size_bytes) ||
      actualSha256 !== row.expected_sha256.trim()
    ) {
      throw new IngestionProcessingError(
        "ASSET_CHECKSUM_MISMATCH",
        false,
        "Object size or SHA-256 differs from the declaration",
      );
    }
    return { sizeBytes, sha256: actualSha256 };
  }

  private async validateFile(row: ProcessingRow, filePath: string): Promise<{ validation: Record<string, unknown>; normalized?: Buffer }> {
    if (row.asset_type === "audio") {
      try {
        const { stdout } = await execFileAsync(
          this.ffprobePath,
          ["-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", filePath],
          { timeout: 30_000, maxBuffer: 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: string; format_name?: string };
        };
        const durationSeconds = Number(parsed.format?.duration);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw new Error("duration missing");
        }
        return { validation: {
          durationMs: Math.round(durationSeconds * 1000),
          formatName: parsed.format?.format_name ?? "unknown",
        } };
      } catch {
        throw new IngestionProcessingError(
          "INGESTION_JOB_FAILED",
          false,
          "Audio file failed ffprobe validation",
        );
      }
    }

    const format = row.asset_type === "subtitles" ? timedSubtitleFormat(row.mime_type, row.file_name) : null;
    if (format) {
      try {
        const normalized = await normalizeTimedSubtitles(createReadStream(filePath), format);
        return { normalized: normalized.bytes, validation: {
          cueCount: normalized.cueCount, lastEndMs: normalized.lastEndMs, vocabularyReferences: [],
          conversion: { ...normalized.conversion, sourceSha256: row.expected_sha256.trim(), sourceSizeBytes: Number(row.expected_size_bytes), sourceMimeType: row.mime_type },
        } };
      } catch (error) {
        if (error instanceof SubtitleNormalizationError) throw new IngestionProcessingError("SUBTITLE_VALIDATION_FAILED", false, error.message);
        throw error;
      }
    }
    const bytes = await readFile(filePath);
    if (row.asset_type === "subtitles") {
      const text = decodeUtf8(bytes);
      try {
        const value: unknown = JSON.parse(text);
        return { validation: { ...validateSubtitleJson(value), ...validateSubtitleReferences(value) } };
      } catch (error) {
        if (error instanceof IngestionProcessingError) throw error;
        throw new IngestionProcessingError("SUBTITLE_VALIDATION_FAILED", false, "Subtitle JSON is invalid");
      }
    }

    if (["vocabulary", "quiz", "metadata"].includes(row.asset_type)) {
      try {
        const value = JSON.parse(decodeUtf8(bytes)) as unknown;
        if (row.asset_type === "metadata") return { validation: { catalogMetadata: validateCatalogMetadata(value, { workId: row.work_id, pieceId: row.piece_id, contentVersion: row.content_version }) } };
        if (row.asset_type === "quiz") return { validation: { quizPackage: validateQuizPackage(value, { workId: row.work_id, pieceId: row.piece_id, contentVersion: row.content_version }) } };
        if (row.asset_type === "vocabulary") return { validation: validateVocabularyPackage(value) };
      } catch {
        throw new IngestionProcessingError("INGESTION_JOB_FAILED", false, "JSON asset is invalid");
      }
    }
    if (row.asset_type === "text") decodeUtf8(bytes);
    return { validation: {} };
  }

  private async finalizeBatchIfComplete(client: PoolClient, row: ProcessingRow): Promise<void> {
    const counts = await client.query<{ pending: string; failed: string; ready: string }>(
      `SELECT
         count(*) FILTER (WHERE status NOT IN ('ready', 'failed', 'cancelled'))::text AS pending,
         count(*) FILTER (WHERE status = 'failed')::text AS failed,
         count(*) FILTER (WHERE status = 'ready')::text AS ready
       FROM ingestion_items WHERE batch_id = $1`,
      [row.batch_id],
    );
    const count = counts.rows[0]!;
    await client.query(
      `UPDATE ingestion_batches SET
         succeeded_count = $2,
         failed_count = $3,
         status = CASE
           WHEN $1::integer > 0 THEN 'processing'
           WHEN $3::integer > 0 THEN 'partial_failed'
           ELSE 'ready_for_review'
         END
       WHERE id = $4`,
      [Number(count.pending), Number(count.ready), Number(count.failed), row.batch_id],
    );
    if (count.pending !== "0" || count.failed !== "0") return;

    const assets = await client.query<{
      item_id: string;
      asset_type: string;
      mime_type: string;
      size_bytes: string;
      sha256: string;
      artifact_id: string;
      bucket: string;
      object_key: string;
      validation: Record<string, unknown>;
    }>(
      `SELECT i.id AS item_id, i.asset_type, pa.mime_type, pa.size_bytes,
              pa.sha256, pa.id AS artifact_id, pa.bucket, pa.object_key, pa.validation
       FROM ingestion_items i
       JOIN processing_jobs j ON j.ingestion_item_id = i.id AND j.job_type = 'package_validate'
       JOIN processing_artifacts pa ON pa.processing_job_id = j.id AND pa.artifact_kind = 'ready'
       WHERE i.batch_id = $1 ORDER BY i.asset_type`,
      [row.batch_id],
    );
    const manifestSha256 = createHash("sha256")
      .update(
        JSON.stringify(
          assets.rows.map((asset) => ({
            type: asset.asset_type,
            sha256: asset.sha256.trim(),
            sizeBytes: Number(asset.size_bytes),
          })),
        ),
      )
      .digest("hex");
    const contentVersion = await client.query<{ id: string }>(
      `INSERT INTO content_versions (
         piece_id, content_version, status, publishable, manifest_sha256,
         source_batch_id, provenance
       ) VALUES ($1, $2, 'ready_for_review', false, $3, $4, $5)
       ON CONFLICT (piece_id, content_version) DO NOTHING
       RETURNING id`,
      [
        row.piece_id,
        row.content_version,
        manifestSha256,
        row.batch_id,
        JSON.stringify({
          source: row.source,
          sourceCommitSha: row.source_commit_sha,
          toolVersion: row.tool_version,
        }),
      ],
    );
    let contentVersionId = contentVersion.rows[0]?.id;
    if (!contentVersionId) {
      const existing = await client.query<{ id: string; source_batch_id: string | null }>(
        "SELECT id, source_batch_id FROM content_versions WHERE piece_id = $1 AND content_version = $2",
        [row.piece_id, row.content_version],
      );
      if (existing.rows[0]?.source_batch_id !== row.batch_id) {
        throw new IngestionProcessingError(
          "INGESTION_BATCH_CONFLICT",
          false,
          "Content version already belongs to another batch",
        );
      }
      contentVersionId = existing.rows[0]?.id;
    }
    if (!contentVersionId) throw new Error("Content version could not be assembled");
    const metadata = assets.rows.find(asset => asset.asset_type === "metadata")?.validation.catalogMetadata;
    const audioDuration = assets.rows.find(asset => asset.asset_type === "audio")?.validation.durationMs;
    const quizAsset = assets.rows.find(asset => asset.asset_type === "quiz");
    const quiz = quizAsset?.validation.quizPackage as ValidatedQuiz | undefined;
    if (!metadata || !Number.isSafeInteger(audioDuration) || Number(audioDuration) <= 0 || !quiz || !quizAsset) throw new IngestionProcessingError("INGESTION_JOB_FAILED", false, "Complete validated metadata, audio duration and Quiz are required");
    const subtitles = assets.rows.find(asset => asset.asset_type === "subtitles")?.validation;
    const vocabulary = assets.rows.find(asset => asset.asset_type === "vocabulary")?.validation;
    const vocabularyKeys = vocabulary?.vocabularyKeys;
    if (!subtitles || !Number.isSafeInteger(subtitles.lastEndMs) || Number(subtitles.lastEndMs) > Number(audioDuration) + 250 || !Array.isArray(subtitles.vocabularyReferences) || !Array.isArray(vocabularyKeys) || subtitles.vocabularyReferences.some(key => !vocabularyKeys.includes(key))) {
      throw new IngestionProcessingError("SUBTITLE_VALIDATION_FAILED", false, "Subtitle duration or contextual vocabulary does not match this resource version");
    }
    await client.query("UPDATE content_versions SET catalog_metadata=$2 WHERE id=$1", [contentVersionId, JSON.stringify(metadata)]);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO quiz_packages(piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold)
       VALUES($1,$2,$3,$4,'draft',$5) ON CONFLICT(piece_id,content_version,quiz_version) DO NOTHING RETURNING id`,
      [row.piece_id,row.content_version,quiz.quizVersion,quizAsset.sha256.trim(),quiz.masteryThreshold],
    );
    const quizPackageId = inserted.rows[0]?.id ?? (await client.query<{ id: string }>("SELECT id FROM quiz_packages WHERE piece_id=$1 AND content_version=$2 AND quiz_version=$3 AND package_sha256=$4", [row.piece_id,row.content_version,quiz.quizVersion,quizAsset.sha256.trim()])).rows[0]?.id;
    if (!quizPackageId) throw new IngestionProcessingError("INGESTION_BATCH_CONFLICT", false, "Quiz version belongs to another package");
    for (const [index,question] of quiz.questions.entries()) {
      await client.query(`INSERT INTO quiz_questions(quiz_package_id,question_id,prompt,options,correct_option,sort_order)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(quiz_package_id,question_id) DO NOTHING`,
        [quizPackageId,question.id,question.prompt,JSON.stringify(question.options),question.answer,index]);
    }
    for (const asset of assets.rows) {
      await client.query(
        `INSERT INTO content_assets (
           piece_id, content_version, asset_type, source_artifact_id,
           bucket, object_key, sha256, size_bytes, mime_type, duration_ms, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ready')
         ON CONFLICT (piece_id, content_version, asset_type) DO NOTHING`,
        [
          row.piece_id,
          row.content_version,
          asset.asset_type,
          asset.artifact_id,
          asset.bucket,
          asset.object_key,
          asset.sha256.trim(),
          Number(asset.size_bytes),
          asset.mime_type,
          asset.asset_type === "audio" ? audioDuration : null,
        ],
      );
    }
  }

  private async recordFailure(client:PoolClient,id:string,error:IngestionProcessingError,finalAttempt:boolean,generation:number):Promise<void>{
    await client.query("BEGIN");
    try{
      const locator=(await client.query<{batch_id:string}>("SELECT i.batch_id FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE j.id=$1",[id])).rows[0];
      if(!locator){await client.query("COMMIT");return;}
      await client.query("SELECT id FROM ingestion_batches WHERE id=$1 FOR UPDATE",[locator.batch_id]);
      const row=(await client.query<{ingestion_item_id:string}>("SELECT j.ingestion_item_id FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id JOIN ingestion_batches b ON b.id=i.batch_id WHERE j.id=$1 AND j.dispatch_generation=$2 AND j.status IN (\'running\',\'queued\',\'retry_wait\') AND b.status<>\'cancelled\' FOR UPDATE OF i,j",[id,generation])).rows[0];
      if(!row){await client.query("COMMIT");return;}
      const status=error.retryable&&!finalAttempt?"retry_wait":error.retryable?"dead_letter":"failed";
      await client.query("UPDATE processing_jobs SET status=$2,error_code=$3,error_summary=$4,next_retry_at=CASE WHEN $2=\'retry_wait\' THEN now()+interval \'30 seconds\' ELSE NULL END,finished_at=CASE WHEN $2=\'retry_wait\' THEN NULL ELSE now() END WHERE id=$1",[id,status,error.code,error.message.slice(0,500)]);
      await client.query("UPDATE ingestion_items SET status=$2,error_code=$3,error_summary=$4 WHERE id=$1",[row.ingestion_item_id,status==="retry_wait"?"queued":"failed",status==="retry_wait"?null:error.code,status==="retry_wait"?null:error.message.slice(0,500)]);
      await client.query("UPDATE ingestion_batches SET failed_count=(SELECT count(*) FROM ingestion_items WHERE batch_id=$1 AND status=\'failed\'),succeeded_count=(SELECT count(*) FROM ingestion_items WHERE batch_id=$1 AND status=\'ready\'),status=CASE WHEN $2=\'retry_wait\' OR EXISTS(SELECT 1 FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=$1 AND j.status=\'running\') THEN \'processing\' ELSE \'partial_failed\' END WHERE id=$1",[locator.batch_id,status]);
      await client.query("COMMIT");
    }catch(failure){await client.query("ROLLBACK");throw failure;}
  }

  async process(processingJobId: string, attempt: number, maxAttempts: number,dispatchGeneration=0): Promise<void> {
    const client = await this.pool.connect();
    const lockName = `ingestion-job:${processingJobId}`;
    let locked = false;
    let claimed=false,cumulativeLast=false;
    let tempDirectory: string | undefined;
    try {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [lockName],
      );
      locked = lock.rows[0]?.locked ?? false;
      if (!locked) {
        throw new IngestionProcessingError("INGESTION_JOB_FAILED", true, "Job is already being processed");
      }
      await client.query("BEGIN");
      const locator=await this.readJob(client,processingJobId);
      await client.query("SELECT id FROM ingestion_batches WHERE id=$1 FOR UPDATE",[locator.batch_id]);
      const row=await this.readJob(client,processingJobId);
      if(row.batch_status==="cancelled"||!["queued","retry_wait","running"].includes(row.job_status)||row.dispatch_generation!==dispatchGeneration){await client.query("COMMIT");return;}
      claimed=true;cumulativeLast=row.attempt_count+1>=row.max_attempts;
      if(row.attempt_count>=row.max_attempts){await client.query("COMMIT");throw new IngestionProcessingError("INGESTION_JOB_FAILED",false,"Cumulative attempt limit reached");}
      await client.query(
        `UPDATE processing_jobs SET status = 'running', attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, now()), worker_id = $2
         WHERE id = $1`,
        [processingJobId, `${process.pid}`],
      );
      await client.query("UPDATE ingestion_items SET status = 'processing' WHERE id = $1", [row.item_id]);
      await client.query("UPDATE ingestion_batches SET status = 'processing' WHERE id = $1", [row.batch_id]);
      await client.query("COMMIT");
      assertReaderAssetDeclaration(row.asset_type,row.mime_type,row.file_name,Number(row.expected_size_bytes));

      tempDirectory = await mkdtemp(join(this.temporaryRoot, "tingyue-worker-"));
      const filePath = join(tempDirectory, safeTempName(row.file_name));
      const streamed = await this.streamObjectToFile(row, filePath);
      const prepared = await this.validateFile(row, filePath), validation = prepared.validation;
      const readyKey = `ready/${row.piece_id}/v${row.content_version}/${row.asset_type}/${basename(row.object_key)}${prepared.normalized ? "." + timedSubtitleConverterVersion + ".json" : ""}`;
      const ready = prepared.normalized ? { sha256: createHash("sha256").update(prepared.normalized).digest("hex"), sizeBytes: prepared.normalized.length, mimeType: "application/json" } : { ...streamed, mimeType: row.mime_type };
      if (prepared.normalized) await this.s3.send(new PutObjectCommand({ Bucket: row.bucket, Key: readyKey, Body: prepared.normalized,
        ContentLength: ready.sizeBytes, ContentType: ready.mimeType, Metadata: { "source-sha256": streamed.sha256, converter: timedSubtitleConverterVersion } }));
      else await this.s3.send(
        new CopyObjectCommand({
          Bucket: row.bucket,
          Key: readyKey,
          CopySource: copySource(row.bucket, row.object_key),
          MetadataDirective: "COPY",
        }),
      );

      await client.query("BEGIN");
      // Serialize completion before counting: parallel final items must see committed siblings.
      await client.query("SELECT id FROM ingestion_batches WHERE id=$1 FOR UPDATE",[row.batch_id]);
      const current=await this.readJob(client,processingJobId);
      if(current.batch_status==="cancelled"||current.dispatch_generation!==dispatchGeneration||current.job_status!=="running"){await client.query("COMMIT");return;}
      let parentArtifactId: string | null = null;
      if (prepared.normalized) {
        const original = await client.query<{ id: string }>(
          `INSERT INTO processing_artifacts(processing_job_id,artifact_kind,bucket,object_key,sha256,size_bytes,mime_type,validation)
           VALUES($1,'original',$2,$3,$4,$5,$6,'{}') ON CONFLICT(bucket,object_key) DO NOTHING RETURNING id`,
          [processingJobId,row.bucket,row.object_key,streamed.sha256,streamed.sizeBytes,row.mime_type]);
        parentArtifactId = original.rows[0]?.id ?? (await client.query<{ id: string }>("SELECT id FROM processing_artifacts WHERE bucket=$1 AND object_key=$2", [row.bucket,row.object_key])).rows[0]!.id;
      }
      await client.query(
        `INSERT INTO processing_artifacts (
           processing_job_id, artifact_kind, bucket, object_key, sha256, size_bytes, mime_type, validation, parent_artifact_id
         ) VALUES ($1, 'ready', $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (bucket, object_key) DO NOTHING`,
        [processingJobId, row.bucket, readyKey, ready.sha256, ready.sizeBytes, ready.mimeType, JSON.stringify(validation), parentArtifactId],
      );
      await client.query(
        "UPDATE processing_jobs SET status = 'succeeded', finished_at = now(), error_code = NULL, error_summary = NULL WHERE id = $1",
        [processingJobId],
      );
      await client.query(
        "UPDATE ingestion_items SET status = 'ready', error_code = NULL, error_summary = NULL WHERE id = $1",
        [row.item_id],
      );
      await client.query(
        `INSERT INTO audit_events (
           actor_type, actor_id, action, target_type, target_id, request_id, metadata
         ) VALUES ('worker', $1, 'ingestion_item_validated', 'ingestion_item', $2, $3, $4)`,
        [
          `${process.pid}`,
          row.item_id,
          processingJobId,
          JSON.stringify({ validation: { ...validation, quizPackage: validation.quizPackage ? { questionCount: (validation.quizPackage as ValidatedQuiz).questions.length } : undefined }, sha256: ready.sha256, sizeBytes: ready.sizeBytes }),
        ],
      );
      await this.finalizeBatchIfComplete(client, row);
      await client.query("COMMIT");
    } catch (unknownError) {
      await client.query("ROLLBACK").catch(() => undefined);
      const error =
        unknownError instanceof IngestionProcessingError
          ? unknownError
          : new IngestionProcessingError("INGESTION_JOB_FAILED", true, "Unexpected processing failure");
      if(claimed)await this.recordFailure(client,processingJobId,error,cumulativeLast||attempt>=maxAttempts,dispatchGeneration);
      throw error;
    } finally {
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
      client.release();
    }
  }
}

function safeTempName(fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
  return safe || "asset.bin";
}
