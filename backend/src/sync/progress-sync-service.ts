import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { ApiError } from "../api/errors.ts";
import {
  deriveProgressFacts,
  mergeProgressEvidence,
  type MillisecondRange,
  type StoredProgressState,
} from "./progress-state.ts";

export type ProgressSyncOperation = {
  operationId: string;
  pieceId: string;
  contentVersion: number;
  durationMs: number;
  baseRevision: string;
  listenedRangeDeltasMs: MillisecondRange[];
  checkpointMs: number | null;
  naturalEndObserved: boolean;
  occurredAt: string;
};

export type ProgressSyncInput = {
  schemaVersion: 1;
  batchId: string;
  cursor: string | null;
  operations: ProgressSyncOperation[];
  limit: number;
};

export type ProgressView = {
  pieceId: string;
  contentVersion: number;
  durationMs: number;
  revision: string;
  checkpointMs: number;
  listenedRangesMs: MillisecondRange[];
  listenedMs: number;
  coverage: number;
  completed: boolean;
  naturalEndObserved: boolean;
  serverUpdatedAt: string;
};

export type ProgressOperationResult = {
  operationId: string;
  pieceId: string;
  status: "applied" | "merged_stale" | "unchanged" | "rejected";
  checkpointDecision: "accepted" | "server_retained" | "not_provided" | "not_applicable";
  clockStatus: "ok" | "future_skew";
  reason: string | null;
  progress: ProgressView | null;
};

export type ProgressSyncResponse = {
  schemaVersion: 1;
  batchId: string;
  serverTime: string;
  operations: ProgressOperationResult[];
  changes: ProgressView[];
  nextCursor: string;
  hasMore: boolean;
};

type ProgressRow = {
  piece_id: string;
  content_version: number;
  duration_ms: number;
  revision: string;
  checkpoint_ms: number;
  listened_ranges_ms: MillisecondRange[];
  listened_ms: number;
  coverage: string | number;
  completed: boolean;
  natural_end_observed: boolean;
  server_updated_at: Date;
  change_seq: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function operationPayload(operation: ProgressSyncOperation): Omit<ProgressSyncOperation, "operationId"> {
  const { operationId: _operationId, ...payload } = operation;
  return payload;
}

function batchPayload(input: ProgressSyncInput): Omit<ProgressSyncInput, "batchId"> {
  const { batchId: _batchId, ...payload } = input;
  return payload;
}

export function operationIdFor(operation: Omit<ProgressSyncOperation, "operationId">): string {
  return `s02-op-v1:${hash(operation)}`;
}

export function batchIdFor(input: Omit<ProgressSyncInput, "batchId">): string {
  return `s02-batch-v1:${hash(input)}`;
}

function view(row: ProgressRow): ProgressView {
  return {
    pieceId: row.piece_id,
    contentVersion: row.content_version,
    durationMs: Number(row.duration_ms),
    revision: String(row.revision),
    checkpointMs: Number(row.checkpoint_ms),
    listenedRangesMs: row.listened_ranges_ms,
    listenedMs: Number(row.listened_ms),
    coverage: Number(row.coverage),
    completed: row.completed,
    naturalEndObserved: row.natural_end_observed,
    serverUpdatedAt: row.server_updated_at.toISOString(),
  };
}

function stored(row: ProgressRow): StoredProgressState {
  return {
    pieceId: row.piece_id,
    contentVersion: row.content_version,
    durationMs: Number(row.duration_ms),
    revision: BigInt(row.revision),
    checkpointMs: Number(row.checkpoint_ms),
    listenedRangesMs: row.listened_ranges_ms,
    naturalEndObserved: row.natural_end_observed,
    serverUpdatedAt: row.server_updated_at.toISOString(),
  };
}

export class ProgressSyncService {
  private readonly cursorKey: Buffer;
  private readonly pool: Pool;

  constructor(
    pool: Pool,
    cursorKeyBase64: string,
  ) {
    this.pool = pool;
    this.cursorKey = Buffer.from(cursorKeyBase64, "base64");
    if (this.cursorKey.length !== 32) throw new Error("Progress cursor key must be 32 bytes");
  }

  async sync(
    userId: string,
    deviceId: string,
    input: ProgressSyncInput,
  ): Promise<ProgressSyncResponse> {
    const requestHash = hash(input);
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `progress-sync:${userId}:${input.batchId}`,
      ]);
      const existing = await client.query<{
        request_hash: string;
        response: ProgressSyncResponse | null;
        status: string;
      }>(
        "SELECT request_hash,status,response FROM progress_sync_batches WHERE user_id=$1 AND batch_id=$2",
        [userId, input.batchId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.request_hash.trim() !== requestHash) {
          throw new ApiError("IDEMPOTENCY_KEY_REUSED", 409, false, "batchId was already used with a different request");
        }
        if (row.status === "completed" && row.response) {
          await client.query("COMMIT");
          transactionOpen = false;
          return row.response;
        }
        throw new ApiError("CONFLICT", 409, true, "Progress sync batch is already processing");
      }
      if (batchIdFor(batchPayload(input)) !== input.batchId) {
        throw new ApiError("INVALID_REQUEST", 400, false, "batchId does not match the canonical request");
      }
      const cursorSequence = this.readCursor(userId, input.cursor);
      await client.query(
        "INSERT INTO progress_sync_batches (user_id,batch_id,request_hash,status) VALUES ($1,$2,$3,'processing')",
        [userId, input.batchId, requestHash],
      );

      const operationResults: ProgressOperationResult[] = [];
      for (const operation of input.operations) {
        operationResults.push(await this.applyOperation(client, userId, deviceId, input.batchId, operation));
      }
      const pulled = await client.query<ProgressRow>(
        `SELECT piece_id,content_version,duration_ms,revision::text,checkpoint_ms,
                listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,
                server_updated_at,change_seq::text
         FROM user_learning_progress
         WHERE user_id=$1 AND change_seq>$2
         ORDER BY change_seq ASC
         LIMIT $3`,
        [userId, cursorSequence.toString(), input.limit + 1],
      );
      const hasMore = pulled.rows.length > input.limit;
      const selected = pulled.rows.slice(0, input.limit);
      const nextSequence = selected.length
        ? BigInt(selected.at(-1)!.change_seq)
        : cursorSequence;
      const response: ProgressSyncResponse = {
        schemaVersion: 1,
        batchId: input.batchId,
        serverTime: new Date().toISOString(),
        operations: operationResults,
        changes: selected.map(view),
        nextCursor: this.writeCursor(userId, nextSequence),
        hasMore,
      };
      await client.query(
        "UPDATE progress_sync_batches SET status='completed',response=$3,completed_at=now() WHERE user_id=$1 AND batch_id=$2",
        [userId, input.batchId, JSON.stringify(response)],
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return response;
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyOperation(
    client: PoolClient,
    userId: string,
    deviceId: string,
    batchId: string,
    operation: ProgressSyncOperation,
  ): Promise<ProgressOperationResult> {
    const operationHash = hash(operation);
    const replay = await client.query<{ request_hash: string; response: ProgressOperationResult }>(
      "SELECT request_hash,response FROM progress_sync_operations WHERE user_id=$1 AND operation_id=$2",
      [userId, operation.operationId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash.trim() !== operationHash) {
        throw new ApiError("IDEMPOTENCY_KEY_REUSED", 409, false, "operationId was already used with different evidence");
      }
      return replay.rows[0].response;
    }
    if (operationIdFor(operationPayload(operation)) !== operation.operationId) {
      throw new ApiError("INVALID_REQUEST", 400, false, "operationId does not match its canonical operation");
    }

    const now = new Date();
    const occurredAt = new Date(operation.occurredAt);
    const clockStatus = occurredAt.getTime() > now.getTime() + 5 * 60_000 ? "future_skew" as const : "ok" as const;
    const resource = await client.query<{ content_version: number; duration_ms: string | null }>(
      `SELECT cv.content_version,asset.duration_ms::text
       FROM pieces p
       JOIN content_versions cv ON cv.id=p.current_content_version_id
       LEFT JOIN content_assets asset ON asset.piece_id=p.id
         AND asset.content_version=cv.content_version
         AND asset.asset_type='audio' AND asset.status IN ('ready','published')
       WHERE p.id=$1 AND p.status='published' AND cv.status='published'`,
      [operation.pieceId],
    );
    const published = resource.rows[0];
    const serverDuration = published?.duration_ms === null || published?.duration_ms === undefined
      ? null
      : Number(published.duration_ms);
    if (!published || published.content_version !== operation.contentVersion || !serverDuration) {
      return this.saveOperation(client, userId, batchId, operation, {
        operationId: operation.operationId,
        pieceId: operation.pieceId,
        status: "rejected",
        checkpointDecision: "not_applicable",
        clockStatus,
        reason: "content_version_unavailable",
        progress: null,
      });
    }
    if (Math.abs(serverDuration - operation.durationMs) > 500) {
      return this.saveOperation(client, userId, batchId, operation, {
        operationId: operation.operationId,
        pieceId: operation.pieceId,
        status: "rejected",
        checkpointDecision: "not_applicable",
        clockStatus,
        reason: "duration_mismatch",
        progress: null,
      });
    }

    const selected = await client.query<ProgressRow>(
      `SELECT piece_id,content_version,duration_ms,revision::text,checkpoint_ms,
              listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,
              server_updated_at,change_seq::text
       FROM user_learning_progress WHERE user_id=$1 AND piece_id=$2 FOR UPDATE`,
      [userId, operation.pieceId],
    );
    const previousRow = selected.rows[0] ?? null;
    const previous = previousRow?.content_version === operation.contentVersion
      ? stored(previousRow)
      : null;
    if (previousRow && !previous && operation.baseRevision !== "0") {
      return this.saveOperation(client, userId, batchId, operation, {
        operationId: operation.operationId,
        pieceId: operation.pieceId,
        status: "rejected",
        checkpointDecision: "not_applicable",
        clockStatus,
        reason: "content_revision_reset_required",
        progress: view(previousRow),
      });
    }
    const merged = mergeProgressEvidence(
      previous,
      { pieceId: operation.pieceId, contentVersion: operation.contentVersion, durationMs: serverDuration },
      {
        baseRevision: BigInt(operation.baseRevision),
        checkpointMs: operation.checkpointMs,
        listenedRangeDeltasMs: operation.listenedRangeDeltasMs,
        naturalEndObserved: operation.naturalEndObserved,
      },
      now.toISOString(),
    );
    if (!merged.state || !merged.facts) {
      return this.saveOperation(client, userId, batchId, operation, {
        operationId: operation.operationId,
        pieceId: operation.pieceId,
        status: "rejected",
        checkpointDecision: merged.checkpointDecision,
        clockStatus,
        reason: merged.reason,
        progress: previousRow ? view(previousRow) : null,
      });
    }

    let authoritative: ProgressRow;
    if (merged.changed) {
      if (previousRow) {
        await client.query(
          `INSERT INTO user_learning_progress_history (
             user_id,piece_id,content_version,duration_ms,revision,checkpoint_ms,
             listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,
             server_updated_at,last_device_id,source_kind,source_reference
           ) SELECT user_id,piece_id,content_version,duration_ms,revision,checkpoint_ms,
                    listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,
                    server_updated_at,last_device_id,source_kind,source_snapshot_id
             FROM user_learning_progress WHERE user_id=$1 AND piece_id=$2`,
          [userId, operation.pieceId],
        );
      }
      const written = await client.query<ProgressRow>(
        `INSERT INTO user_learning_progress (
           user_id,piece_id,content_version,duration_ms,revision,checkpoint_ms,
           listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,
           source_updated_at,server_updated_at,last_device_id,source_kind,
           source_snapshot_id,change_seq
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now(),$12,'s02_daily_sync',$13,nextval('user_learning_progress_change_seq'))
         ON CONFLICT (user_id,piece_id) DO UPDATE SET
           content_version=EXCLUDED.content_version,duration_ms=EXCLUDED.duration_ms,
           revision=EXCLUDED.revision,checkpoint_ms=EXCLUDED.checkpoint_ms,
           listened_ranges_ms=EXCLUDED.listened_ranges_ms,listened_ms=EXCLUDED.listened_ms,
           coverage=EXCLUDED.coverage,completed=EXCLUDED.completed,
           natural_end_observed=EXCLUDED.natural_end_observed,
           source_updated_at=EXCLUDED.source_updated_at,server_updated_at=now(),
           imported_at=now(),last_device_id=EXCLUDED.last_device_id,
           source_kind=EXCLUDED.source_kind,source_snapshot_id=EXCLUDED.source_snapshot_id,
           change_seq=nextval('user_learning_progress_change_seq')
         RETURNING piece_id,content_version,duration_ms,revision::text,checkpoint_ms,
                   listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,
                   server_updated_at,change_seq::text`,
        [
          userId,
          operation.pieceId,
          operation.contentVersion,
          serverDuration,
          merged.state.revision.toString(),
          merged.state.checkpointMs,
          JSON.stringify(merged.state.listenedRangesMs),
          merged.facts.listenedMs,
          merged.facts.coverage,
          merged.facts.completed,
          merged.state.naturalEndObserved,
          deviceId,
          batchId,
        ],
      );
      authoritative = written.rows[0]!;
    } else {
      authoritative = previousRow!;
    }
    return this.saveOperation(client, userId, batchId, operation, {
      operationId: operation.operationId,
      pieceId: operation.pieceId,
      status: merged.status,
      checkpointDecision: merged.checkpointDecision,
      clockStatus,
      reason: merged.reason,
      progress: view(authoritative),
    });
  }

  private async saveOperation(
    client: PoolClient,
    userId: string,
    batchId: string,
    operation: ProgressSyncOperation,
    response: ProgressOperationResult,
  ): Promise<ProgressOperationResult> {
    await client.query(
      `INSERT INTO progress_sync_operations (
         user_id,operation_id,batch_id,request_hash,piece_id,response
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, operation.operationId, batchId, hash(operation), operation.pieceId, JSON.stringify(response)],
    );
    return response;
  }

  private writeCursor(userId: string, sequence: bigint): string {
    const payload = `${userId}:${sequence.toString()}`;
    const signature = createHmac("sha256", this.cursorKey).update(payload).digest("hex");
    return `s02-cursor-v1:${sequence.toString()}:${signature}`;
  }

  private readCursor(userId: string, cursor: string | null): bigint {
    if (cursor === null) return 0n;
    const match = /^s02-cursor-v1:(0|[1-9][0-9]*):([a-f0-9]{64})$/.exec(cursor);
    if (!match) throw new ApiError("INVALID_REQUEST", 400, false, "cursor is invalid");
    const sequence = BigInt(match[1]!);
    const supplied = Buffer.from(match[2]!, "hex");
    const expected = createHmac("sha256", this.cursorKey)
      .update(`${userId}:${sequence.toString()}`)
      .digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ApiError("INVALID_REQUEST", 400, false, "cursor signature is invalid");
    }
    return sequence;
  }
}

export const progressSyncCanonical = { canonical, hash, operationIdFor, batchIdFor };
