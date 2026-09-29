import type { FastifyInstance, FastifyRequest } from "fastify";

import type { SessionServicePort } from "./session-routes.ts";
import { ApiError } from "./errors.ts";
import type { AuditService } from "../observability/audit-service.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
import type { MetricsRegistry } from "../observability/metrics.ts";
import type {
  ProgressSyncInput,
  ProgressSyncResponse,
} from "../sync/progress-sync-service.ts";

export type ProgressSyncServicePort = {
  sync(userId: string, deviceId: string, input: ProgressSyncInput): Promise<ProgressSyncResponse>;
};

const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function exact(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ApiError("INVALID_REQUEST", 400, false, `${label} contains forbidden or unknown fields`);
  }
}

function text(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
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

function parseOperation(value: unknown): ProgressSyncInput["operations"][number] {
  if (!plain(value)) throw new ApiError("INVALID_REQUEST", 400, false, "Progress operation must be an object");
  exact(value, [
    "operationId",
    "pieceId",
    "contentVersion",
    "durationMs",
    "baseRevision",
    "listenedRangeDeltasMs",
    "checkpointMs",
    "naturalEndObserved",
    "occurredAt",
  ], "Progress operation");
  const durationMs = integer(value.durationMs, 1, 86_400_000, "durationMs");
  const baseRevision = text(value.baseRevision, 1, 20, "baseRevision");
  if (!/^(0|[1-9][0-9]*)$/.test(baseRevision)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "baseRevision is invalid");
  }
  if (!Array.isArray(value.listenedRangeDeltasMs) || value.listenedRangeDeltasMs.length > 500) {
    throw new ApiError("INVALID_REQUEST", 400, false, "listenedRangeDeltasMs is invalid");
  }
  const ranges = value.listenedRangeDeltasMs.map((range, index) => {
    if (!Array.isArray(range) || range.length !== 2) return null;
    const start = range[0];
    const end = range[1];
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || Number(start) < 0 || Number(end) <= Number(start) || Number(end) > durationMs) return null;
    if (index > 0 && Number(start) <= Number((value.listenedRangeDeltasMs as unknown[][])[index - 1]![1]) + 50) return null;
    return [Number(start), Number(end)] as [number, number];
  });
  if (ranges.some((range) => range === null)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "listenedRangeDeltasMs must be normalized, ordered and in bounds");
  }
  const checkpointMs = value.checkpointMs === null
    ? null
    : integer(value.checkpointMs, 0, durationMs, "checkpointMs");
  if (typeof value.naturalEndObserved !== "boolean") {
    throw new ApiError("INVALID_REQUEST", 400, false, "naturalEndObserved is invalid");
  }
  if (ranges.length === 0 && checkpointMs === null && !value.naturalEndObserved) {
    throw new ApiError("INVALID_REQUEST", 400, false, "Progress operation contains no evidence");
  }
  const occurredAt = new Date(text(value.occurredAt, 20, 40, "occurredAt"));
  if (Number.isNaN(occurredAt.getTime())) {
    throw new ApiError("INVALID_REQUEST", 400, false, "occurredAt is invalid");
  }
  const operationId = text(value.operationId, 74, 74, "operationId");
  if (!/^s02-op-v1:[a-f0-9]{64}$/.test(operationId)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "operationId is invalid");
  }
  return {
    operationId,
    pieceId: text(value.pieceId, 1, 128, "pieceId"),
    contentVersion: integer(value.contentVersion, 1, 1_000_000, "contentVersion"),
    durationMs,
    baseRevision,
    listenedRangeDeltasMs: ranges as Array<[number, number]>,
    checkpointMs,
    naturalEndObserved: value.naturalEndObserved,
    occurredAt: occurredAt.toISOString(),
  };
}

function parseInput(request: FastifyRequest): ProgressSyncInput {
  if (!plain(request.body)) throw new ApiError("INVALID_REQUEST", 400, false, "JSON object body is required");
  exact(request.body, ["schemaVersion", "batchId", "cursor", "operations", "limit"], "Progress sync request");
  if (request.body.schemaVersion !== 1) {
    throw new ApiError("INVALID_REQUEST", 400, false, "schemaVersion is unsupported");
  }
  const batchId = text(request.body.batchId, 77, 77, "batchId");
  if (!/^s02-batch-v1:[a-f0-9]{64}$/.test(batchId)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "batchId is invalid");
  }
  if (request.body.cursor !== null && typeof request.body.cursor !== "string") {
    throw new ApiError("INVALID_REQUEST", 400, false, "cursor is invalid");
  }
  if (!Array.isArray(request.body.operations) || request.body.operations.length > 50) {
    throw new ApiError("INVALID_REQUEST", 400, false, "operations is invalid");
  }
  const operations = request.body.operations.map(parseOperation);
  if (new Set(operations.map((item) => item.operationId)).size !== operations.length) {
    throw new ApiError("INVALID_REQUEST", 400, false, "operationId values must be unique");
  }
  return {
    schemaVersion: 1,
    batchId,
    cursor: request.body.cursor as string | null,
    operations,
    limit: integer(request.body.limit, 1, 100, "limit"),
  };
}

export function registerProgressSyncRoutes(
  app: FastifyInstance,
  service: ProgressSyncServicePort,
  sessions: SessionServicePort,
  audit?: AuditService,
  rateLimiter?: RateLimiterPort,
  metrics?: MetricsRegistry,
): void {
  app.post("/api/v1/me/progress/sync", async (request) => {
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
    await rateLimiter?.consume("progress-sync", session.userId, 30, 60);
    const result = await service.sync(session.userId, session.deviceId, input);
    metrics?.incrementDomain(
      "tingyue_progress_sync_batches_total",
      result.operations.some((item) => item.status === "rejected") ? "completed_with_rejections" : "completed",
    );
    await audit?.record({
      actorType: "user",
      actorId: session.userId,
      action: "progress_sync_completed",
      targetType: "progress_sync_batch",
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
