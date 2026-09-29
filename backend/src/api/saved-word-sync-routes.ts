import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";
import type { AuditService } from "../observability/audit-service.ts";
import type { MetricsRegistry } from "../observability/metrics.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
import type {
  SavedWordSyncInput,
  SavedWordSyncResponse,
} from "../sync/saved-word-sync-service.ts";

export type SavedWordSyncServicePort = {
  sync(userId: string, deviceId: string, input: SavedWordSyncInput): Promise<SavedWordSyncResponse>;
};

const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function exact(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ApiError("INVALID_REQUEST", 400, false, `${label} contains forbidden or unknown fields`);
  }
}

function text(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.trim() !== value) {
    throw new ApiError("INVALID_REQUEST", 400, false, `${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ApiError("INVALID_REQUEST", 400, false, `${label} is invalid`);
  }
  return Number(value);
}

function parseOperation(value: unknown): SavedWordSyncInput["operations"][number] {
  if (!plain(value)) throw new ApiError("INVALID_REQUEST", 400, false, "Saved word operation must be an object");
  exact(value, [
    "operationId",
    "entryId",
    "pieceId",
    "contentVersion",
    "vocabKey",
    "surface",
    "lemma",
    "action",
    "baseRevision",
    "occurredAt",
  ], "Saved word operation");
  const operationId = text(value.operationId, 79, 79, "operationId");
  if (!/^s03-word-op-v1:[a-f0-9]{64}$/.test(operationId)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "operationId is invalid");
  }
  const entryId = text(value.entryId, 15, 67, "entryId");
  if (!/^ve-[a-f0-9]{12,64}$/.test(entryId)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "entryId is invalid");
  }
  const baseRevision = text(value.baseRevision, 1, 20, "baseRevision");
  if (!/^(0|[1-9][0-9]*)$/.test(baseRevision)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "baseRevision is invalid");
  }
  if (value.action !== "save" && value.action !== "delete") {
    throw new ApiError("INVALID_REQUEST", 400, false, "action is invalid");
  }
  const occurredAt = new Date(text(value.occurredAt, 20, 40, "occurredAt"));
  if (Number.isNaN(occurredAt.getTime())) {
    throw new ApiError("INVALID_REQUEST", 400, false, "occurredAt is invalid");
  }
  return {
    operationId,
    entryId,
    pieceId: text(value.pieceId, 1, 128, "pieceId"),
    contentVersion: integer(value.contentVersion, 1, 1_000_000, "contentVersion"),
    vocabKey: text(value.vocabKey, 1, 128, "vocabKey"),
    surface: text(value.surface, 1, 80, "surface"),
    lemma: text(value.lemma, 1, 80, "lemma"),
    action: value.action,
    baseRevision,
    occurredAt: occurredAt.toISOString(),
  };
}

function parseInput(request: FastifyRequest): SavedWordSyncInput {
  if (!plain(request.body)) throw new ApiError("INVALID_REQUEST", 400, false, "JSON object body is required");
  exact(request.body, ["schemaVersion", "batchId", "cursor", "operations", "limit"], "Saved word sync request");
  if (request.body.schemaVersion !== 1) {
    throw new ApiError("INVALID_REQUEST", 400, false, "schemaVersion is unsupported");
  }
  const batchId = text(request.body.batchId, 82, 82, "batchId");
  if (!/^s03-word-batch-v1:[a-f0-9]{64}$/.test(batchId)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "batchId is invalid");
  }
  if (request.body.cursor !== null && (typeof request.body.cursor !== "string" || request.body.cursor.length > 256)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "cursor is invalid");
  }
  if (!Array.isArray(request.body.operations) || request.body.operations.length > 50) {
    throw new ApiError("INVALID_REQUEST", 400, false, "operations is invalid");
  }
  const operations = request.body.operations.map(parseOperation);
  if (new Set(operations.map((item) => item.operationId)).size !== operations.length) {
    throw new ApiError("INVALID_REQUEST", 400, false, "operationId values must be unique");
  }
  if (new Set(operations.map((item) => item.entryId)).size !== operations.length) {
    throw new ApiError("INVALID_REQUEST", 400, false, "A batch may mutate each entryId only once");
  }
  return {
    schemaVersion: 1,
    batchId,
    cursor: request.body.cursor as string | null,
    operations,
    limit: integer(request.body.limit, 1, 100, "limit"),
  };
}

export function registerSavedWordSyncRoutes(
  app: FastifyInstance,
  service: SavedWordSyncServicePort,
  sessions: SessionServicePort,
  audit?: AuditService,
  rateLimiter?: RateLimiterPort,
  metrics?: MetricsRegistry,
): void {
  app.post("/api/v1/me/words/sync", async (request) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new ApiError("UNAUTHENTICATED", 401, false, "Bearer access token is required");
    }
    const session = await sessions.authenticateAccessToken(authorization.slice(7));
    if (!session.deviceId) {
      throw new ApiError("UNAUTHENTICATED", 401, false, "Authenticated session has no device identity");
    }
    const input = parseInput(request);
    if (request.headers["idempotency-key"] !== input.batchId) {
      throw new ApiError("INVALID_REQUEST", 400, false, "Idempotency-Key must equal batchId");
    }
    await rateLimiter?.consume("word-sync", session.userId, 30, 60);
    const result = await service.sync(session.userId, session.deviceId, input);
    metrics?.incrementDomain(
      "tingyue_word_sync_batches_total",
      result.operations.some((item) => item.status === "rejected") ? "completed_with_rejections" : "completed",
    );
    await audit?.record({
      actorType: "user",
      actorId: session.userId,
      action: "saved_word_sync_completed",
      targetType: "word_sync_batch",
      targetId: input.batchId,
      requestId: request.id,
      metadata: {
        operationCount: input.operations.length,
        changeCount: result.changes.length,
        hasMore: result.hasMore,
      },
    });
    return { requestId: request.id, ...result };
  });
}
