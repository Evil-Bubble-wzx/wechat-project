import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { assertContentAccess,hasPurchasedVersion } from "../commerce/access.ts";
import { ApiError } from "../api/errors.ts";
import {
  mergeSavedWordMutation,
  type SavedWordMutation,
  type StoredSavedWordState,
} from "./saved-word-state.ts";

export type SavedWordSyncOperation = {
  operationId: string;
  entryId: string;
  pieceId: string;
  contentVersion: number;
  vocabKey: string;
  surface: string;
  lemma: string;
  action: "save" | "delete";
  baseRevision: string;
  occurredAt: string;
};

export type SavedWordSyncInput = {
  schemaVersion: 1;
  batchId: string;
  cursor: string | null;
  operations: SavedWordSyncOperation[];
  limit: number;
};

export type SavedWordView = {
  entryId: string;
  pieceId: string;
  contentVersion: number;
  vocabKey: string;
  surface: string;
  lemma: string;
  revision: string;
  state: "saved" | "deleted";
  serverUpdatedAt: string;
};

export type SavedWordOperationResult = {
  operationId: string;
  entryId: string;
  status: "applied" | "merged_stale" | "unchanged" | "rejected";
  decision: "saved" | "deleted" | "server_retained" | "not_applicable";
  clockStatus: "ok" | "future_skew";
  reason: string | null;
  word: SavedWordView | null;
};

export type SavedWordSyncResponse = {
  schemaVersion: 1;
  batchId: string;
  serverTime: string;
  operations: SavedWordOperationResult[];
  changes: SavedWordView[];
  nextCursor: string;
  hasMore: boolean;
};

type SavedWordRow = {
  entry_id: string;
  piece_id: string;
  content_version: number;
  vocab_key: string;
  surface: string;
  lemma: string;
  revision: string;
  deleted: boolean;
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

function operationPayload(operation: SavedWordSyncOperation): Omit<SavedWordSyncOperation, "operationId"> {
  const { operationId: _operationId, ...payload } = operation;
  return payload;
}

function batchPayload(input: SavedWordSyncInput): Omit<SavedWordSyncInput, "batchId"> {
  const { batchId: _batchId, ...payload } = input;
  return payload;
}

export function savedWordOperationIdFor(
  operation: Omit<SavedWordSyncOperation, "operationId">,
): string {
  return `s03-word-op-v1:${hash(operation)}`;
}

export function savedWordBatchIdFor(
  input: Omit<SavedWordSyncInput, "batchId">,
): string {
  return `s03-word-batch-v1:${hash(input)}`;
}

function view(row: SavedWordRow): SavedWordView {
  return {
    entryId: row.entry_id,
    pieceId: row.piece_id,
    contentVersion: Number(row.content_version),
    vocabKey: row.vocab_key,
    surface: row.surface,
    lemma: row.lemma,
    revision: String(row.revision),
    state: row.deleted ? "deleted" : "saved",
    serverUpdatedAt: row.server_updated_at.toISOString(),
  };
}

function stored(row: SavedWordRow): StoredSavedWordState {
  return {
    entryId: row.entry_id,
    pieceId: row.piece_id,
    contentVersion: Number(row.content_version),
    vocabKey: row.vocab_key,
    surface: row.surface,
    lemma: row.lemma,
    revision: BigInt(row.revision),
    deleted: row.deleted,
    serverUpdatedAt: row.server_updated_at.toISOString(),
  };
}

const selectColumns = `entry_id,piece_id,content_version,vocab_key,surface,lemma,
  revision::text,deleted,server_updated_at,change_seq::text`;

export class SavedWordSyncService {
  private readonly cursorKey: Buffer;
  private readonly pool: Pool;
  private readonly simulation: boolean;

  constructor(pool: Pool, cursorKeyBase64: string, simulation = false) {
    this.pool = pool;
    this.simulation=simulation;
    this.cursorKey = Buffer.from(cursorKeyBase64, "base64");
    if (this.cursorKey.length !== 32) throw new Error("Saved word cursor key must be 32 bytes");
  }

  async sync(userId: string, deviceId: string, input: SavedWordSyncInput): Promise<SavedWordSyncResponse> {
    const requestHash = hash(input);
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`word-sync:${userId}:${input.batchId}`]);
      const existing = await client.query<{
        request_hash: string;
        response: SavedWordSyncResponse | null;
        status: string;
      }>("SELECT request_hash,status,response FROM word_sync_batches WHERE user_id=$1 AND batch_id=$2", [userId, input.batchId]);
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
        throw new ApiError("CONFLICT", 409, true, "Saved word sync batch is already processing");
      }
      if (savedWordBatchIdFor(batchPayload(input)) !== input.batchId) {
        throw new ApiError("INVALID_REQUEST", 400, false, "batchId does not match the canonical request");
      }
      const cursorSequence = this.readCursor(userId, input.cursor);
      await client.query(
        "INSERT INTO word_sync_batches (user_id,batch_id,request_hash,status) VALUES ($1,$2,$3,'processing')",
        [userId, input.batchId, requestHash],
      );

      const operationResults: SavedWordOperationResult[] = [];
      for (const operation of input.operations) {
        operationResults.push(await this.applyOperation(client, userId, deviceId, input.batchId, operation));
      }
      const pulled = await client.query<SavedWordRow>(
        `SELECT ${selectColumns} FROM user_saved_words
         WHERE user_id=$1 AND change_seq>$2 ORDER BY change_seq ASC LIMIT $3`,
        [userId, cursorSequence.toString(), input.limit + 1],
      );
      const hasMore = pulled.rows.length > input.limit;
      const selected = pulled.rows.slice(0, input.limit);
      const nextSequence = selected.length ? BigInt(selected.at(-1)!.change_seq) : cursorSequence;
      const response: SavedWordSyncResponse = {
        schemaVersion: 1,
        batchId: input.batchId,
        serverTime: new Date().toISOString(),
        operations: operationResults,
        changes: selected.map(view),
        nextCursor: this.writeCursor(userId, nextSequence),
        hasMore,
      };
      await client.query(
        "UPDATE word_sync_batches SET status='completed',response=$3,completed_at=now() WHERE user_id=$1 AND batch_id=$2",
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
    operation: SavedWordSyncOperation,
  ): Promise<SavedWordOperationResult> {
    const operationHash = hash(operation);
    const replay = await client.query<{ request_hash: string; response: SavedWordOperationResult }>(
      "SELECT request_hash,response FROM word_sync_operations WHERE user_id=$1 AND operation_id=$2",
      [userId, operation.operationId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash.trim() !== operationHash) {
        throw new ApiError("IDEMPOTENCY_KEY_REUSED", 409, false, "operationId was already used with a different mutation");
      }
      return replay.rows[0].response;
    }
    if (savedWordOperationIdFor(operationPayload(operation)) !== operation.operationId) {
      throw new ApiError("INVALID_REQUEST", 400, false, "operationId does not match its canonical operation");
    }

    const now = new Date();
    const occurredAt = new Date(operation.occurredAt);
    const clockStatus = occurredAt.getTime() > now.getTime() + 5 * 60_000 ? "future_skew" as const : "ok" as const;
    const selected = await client.query<SavedWordRow>(
      `SELECT ${selectColumns} FROM user_saved_words WHERE user_id=$1 AND entry_id=$2 FOR UPDATE`,
      [userId, operation.entryId],
    );
    const previousRow = selected.rows[0] ?? null;
    const resource = await client.query<{ content_version: number }>(
      `SELECT cv.content_version FROM pieces p
       JOIN content_versions cv ON cv.id=p.current_content_version_id
       WHERE p.id=$1 AND p.status='published' AND cv.status='published'`,
      [operation.pieceId],
    );
    const historicalDelete = operation.action === "delete"
      && previousRow?.piece_id === operation.pieceId
      && previousRow.vocab_key === operation.vocabKey
      && previousRow.lemma === operation.lemma;
    const purchasedOldVersion = await hasPurchasedVersion(client,userId,operation.pieceId,operation.contentVersion,this.simulation)
      && (await client.query("SELECT 1 FROM content_versions WHERE piece_id=$1 AND content_version=$2 AND status IN ('published','superseded')",[operation.pieceId,operation.contentVersion])).rows.length>0;
    if ((!resource.rows[0] || resource.rows[0].content_version !== operation.contentVersion) && !historicalDelete && !purchasedOldVersion) {
      return this.saveOperation(client, userId, batchId, operation, {
        operationId: operation.operationId,
        entryId: operation.entryId,
        status: "rejected",
        decision: "not_applicable",
        clockStatus,
        reason: "content_version_unavailable",
        word: null,
      });
    }

    if (!historicalDelete) await assertContentAccess(client,userId,operation.pieceId,operation.contentVersion,this.simulation,true);
    const retained = operation.action === "delete" && previousRow ? stored(previousRow) : null;
    const mutation: SavedWordMutation = {
      entryId: operation.entryId,
      pieceId: retained?.pieceId ?? operation.pieceId,
      contentVersion: retained?.contentVersion ?? operation.contentVersion,
      vocabKey: retained?.vocabKey ?? operation.vocabKey,
      surface: retained?.surface ?? operation.surface,
      lemma: retained?.lemma ?? operation.lemma,
      action: operation.action,
      baseRevision: BigInt(operation.baseRevision),
    };
    const merged = mergeSavedWordMutation(previousRow ? stored(previousRow) : null, mutation, now.toISOString());
    if (!merged.state || merged.status === "rejected") {
      return this.saveOperation(client, userId, batchId, operation, {
        operationId: operation.operationId,
        entryId: operation.entryId,
        status: "rejected",
        decision: merged.decision,
        clockStatus,
        reason: merged.reason,
        word: previousRow ? view(previousRow) : null,
      });
    }

    let authoritative = previousRow;
    if (merged.changed) {
      if (previousRow) {
        await client.query(
          `INSERT INTO user_saved_word_history (
             user_id,entry_id,piece_id,content_version,vocab_key,surface,lemma,revision,
             deleted,server_updated_at,last_device_id,source_reference
           ) SELECT user_id,entry_id,piece_id,content_version,vocab_key,surface,lemma,revision,
                    deleted,server_updated_at,last_device_id,$3
             FROM user_saved_words WHERE user_id=$1 AND entry_id=$2`,
          [userId, operation.entryId, operation.operationId],
        );
      }
      const saved = await client.query<SavedWordRow>(
        `INSERT INTO user_saved_words (
           user_id,entry_id,piece_id,content_version,vocab_key,surface,lemma,revision,
           deleted,server_updated_at,last_device_id,change_seq
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,nextval('user_saved_words_change_seq'))
         ON CONFLICT (user_id,entry_id) DO UPDATE SET
           piece_id=EXCLUDED.piece_id,content_version=EXCLUDED.content_version,
           vocab_key=EXCLUDED.vocab_key,surface=EXCLUDED.surface,lemma=EXCLUDED.lemma,
           revision=EXCLUDED.revision,deleted=EXCLUDED.deleted,server_updated_at=now(),
           last_device_id=EXCLUDED.last_device_id,change_seq=nextval('user_saved_words_change_seq')
         RETURNING ${selectColumns}`,
        [
          userId,
          merged.state.entryId,
          merged.state.pieceId,
          merged.state.contentVersion,
          merged.state.vocabKey,
          merged.state.surface,
          merged.state.lemma,
          merged.state.revision.toString(),
          merged.state.deleted,
          deviceId,
        ],
      );
      authoritative = saved.rows[0]!;
    }
    return this.saveOperation(client, userId, batchId, operation, {
      operationId: operation.operationId,
      entryId: operation.entryId,
      status: merged.status,
      decision: merged.decision,
      clockStatus,
      reason: merged.reason,
      word: authoritative ? view(authoritative) : null,
    });
  }

  private async saveOperation(
    client: PoolClient,
    userId: string,
    batchId: string,
    operation: SavedWordSyncOperation,
    response: SavedWordOperationResult,
  ): Promise<SavedWordOperationResult> {
    await client.query(
      `INSERT INTO word_sync_operations (user_id,operation_id,batch_id,request_hash,entry_id,response)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, operation.operationId, batchId, hash(operation), operation.entryId, JSON.stringify(response)],
    );
    return response;
  }

  private writeCursor(userId: string, sequence: bigint): string {
    const payload = `${userId}:${sequence.toString()}`;
    const signature = createHmac("sha256", this.cursorKey).update(`s03-word:${payload}`).digest("hex");
    return `s03-word-cursor-v1:${sequence.toString()}:${signature}`;
  }

  private readCursor(userId: string, cursor: string | null): bigint {
    if (cursor === null) return 0n;
    const match = /^s03-word-cursor-v1:(0|[1-9][0-9]*):([a-f0-9]{64})$/.exec(cursor);
    if (!match) throw new ApiError("INVALID_REQUEST", 400, false, "Saved word cursor is invalid");
    const sequence = BigInt(match[1]!);
    const expected = this.writeCursor(userId, sequence).split(":").at(-1)!;
    const supplied = match[2]!;
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
      throw new ApiError("INVALID_REQUEST", 400, false, "Saved word cursor signature is invalid");
    }
    return sequence;
  }
}
