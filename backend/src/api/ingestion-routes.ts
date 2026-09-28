import type { FastifyInstance, FastifyRequest } from "fastify";

import type {
  CreateBatchInput,
  IngestionService,
} from "../ingestion/service.ts";
import type { AuditService } from "../observability/audit-service.ts";
import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";

type AdminSessionService = SessionServicePort & {
  assertContentAdmin(userId: string): Promise<void>;
};

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;
const maxBytesByAssetType: Record<CreateBatchInput["items"][number]["assetType"], number> = {
  audio: 5 * GIBIBYTE,
  subtitles: 100 * MEBIBYTE,
  text: 100 * MEBIBYTE,
  vocabulary: 100 * MEBIBYTE,
  quiz: 100 * MEBIBYTE,
  cover: 50 * MEBIBYTE,
  metadata: 20 * MEBIBYTE,
};
const allowedMimeTypes: Record<CreateBatchInput["items"][number]["assetType"], Set<string>> = {
  audio: new Set(["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/flac", "application/octet-stream"]),
  subtitles: new Set(["application/json", "text/vtt", "application/x-subrip", "text/plain", "application/octet-stream"]),
  text: new Set(["text/plain", "text/markdown", "application/json", "application/octet-stream"]),
  vocabulary: new Set(["application/json", "text/csv", "application/octet-stream"]),
  quiz: new Set(["application/json", "application/octet-stream"]),
  cover: new Set(["image/jpeg", "image/png", "image/webp", "image/svg+xml", "application/octet-stream"]),
  metadata: new Set(["application/json", "application/octet-stream"]),
};

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "JSON object body is required");
  }
  return request.body as Record<string, unknown>;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new ApiError("INVALID_REQUEST", 400, false, "Valid Idempotency-Key is required");
  }
  return value;
}

function bearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length <= 7) {
    throw new ApiError("UNAUTHENTICATED", 401, false, "Bearer access token is required");
  }
  return value.slice(7);
}

async function adminUserId(request: FastifyRequest, sessions: AdminSessionService) {
  const session = await sessions.authenticateAccessToken(bearerToken(request));
  await sessions.assertContentAdmin(session.userId);
  return session.userId;
}

function stringField(body: Record<string, unknown>, field: string, max = 512): string {
  const value = body[field];
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new ApiError("INVALID_REQUEST", 400, false, `${field} is invalid`, { field });
  }
  return value;
}

function pathId(request: FastifyRequest, field: string): string {
  const value = (request.params as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new ApiError("INVALID_REQUEST", 400, false, `${field} is invalid`, { field });
  }
  return value;
}

export function parseBatch(body: Record<string, unknown>): CreateBatchInput {
  if (!Number.isInteger(body.contentVersion) || Number(body.contentVersion) < 1) {
    throw new ApiError("INVALID_REQUEST", 400, false, "contentVersion is invalid");
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 1000) {
    throw new ApiError("INVALID_REQUEST", 400, false, "items must contain 1 to 1000 declarations");
  }
  const allowedTypes = new Set([
    "audio",
    "subtitles",
    "text",
    "vocabulary",
    "quiz",
    "cover",
    "metadata",
  ]);
  const items = body.items.map((unknownItem) => {
    if (!unknownItem || typeof unknownItem !== "object" || Array.isArray(unknownItem)) {
      throw new ApiError("INVALID_REQUEST", 400, false, "Each item must be an object");
    }
    const item = unknownItem as Record<string, unknown>;
    const assetType = stringField(item, "assetType", 32);
    if (!allowedTypes.has(assetType)) {
      throw new ApiError("INVALID_REQUEST", 400, false, "assetType is invalid");
    }
    const sizeBytes = Number(item.sizeBytes);
    const digest = stringField(item, "sha256", 64);
    const mimeType = stringField(item, "mimeType", 255).toLowerCase();
    if (
      !Number.isSafeInteger(sizeBytes)
      || sizeBytes < 1
      || sizeBytes > maxBytesByAssetType[assetType as keyof typeof maxBytesByAssetType]
      || !/^[a-f0-9]{64}$/.test(digest)
      || !allowedMimeTypes[assetType as keyof typeof allowedMimeTypes].has(mimeType)
    ) {
      throw new ApiError("INVALID_REQUEST", 400, false, "File size, digest or MIME type is invalid");
    }
    return {
      clientFileId: stringField(item, "clientFileId", 128),
      assetType: assetType as CreateBatchInput["items"][number]["assetType"],
      fileName: stringField(item, "fileName"),
      sizeBytes,
      mimeType,
      sha256: digest,
    };
  });
  if (new Set(items.map(({ clientFileId }) => clientFileId)).size !== items.length) {
    throw new ApiError("INVALID_REQUEST", 400, false, "clientFileId values must be unique");
  }
  if (items.reduce((total, item) => total + item.sizeBytes, 0) > 100 * GIBIBYTE) {
    throw new ApiError("INVALID_REQUEST", 400, false, "Batch size exceeds 100 GiB");
  }
  return {
    source: stringField(body, "source", 128),
    sourceCommitSha: stringField(body, "sourceCommitSha", 64),
    toolVersion: stringField(body, "toolVersion", 128),
    workId: stringField(body, "workId", 128),
    pieceId: stringField(body, "pieceId", 128),
    contentVersion: Number(body.contentVersion),
    items,
  };
}

export function registerIngestionRoutes(
  app: FastifyInstance,
  ingestion: IngestionService,
  sessions: AdminSessionService,
  audit?: AuditService,
): void {
  app.post("/api/v1/admin/ingestion-batches", async (request, reply) => {
    const actorUserId = await adminUserId(request, sessions);
    const response = await ingestion.createBatch(
      parseBatch(bodyObject(request)),
      actorUserId,
      idempotencyKey(request),
    );
    await audit?.record({actorType:"admin",actorId:actorUserId,action:"ingestion_batch_created",targetType:"ingestion_batch",targetId:response.batchId,requestId:request.id,metadata:{itemCount:response.items.length}});
    return reply.code(201).send({ requestId: request.id, ...response });
  });

  app.get("/api/v1/admin/ingestion-batches/:batchId", async (request) => {
    const actorUserId=await adminUserId(request, sessions);
    const batchId=pathId(request,"batchId");
    const response=await ingestion.getBatch(batchId);
    await audit?.record({actorType:"admin",actorId:actorUserId,action:"ingestion_batch_read",targetType:"ingestion_batch",targetId:batchId,requestId:request.id});
    return { requestId: request.id, ...response };
  });

  app.post("/api/v1/admin/upload-sessions", async (request, reply) => {
    const actorUserId=await adminUserId(request, sessions);
    const body = bodyObject(request);
    const response = await ingestion.createUploadSession(
      {
        batchId: stringField(body, "batchId", 128),
        clientFileId: stringField(body, "clientFileId", 128),
      },
      idempotencyKey(request),
    );
    await audit?.record({actorType:"admin",actorId:actorUserId,action:"upload_session_created",targetType:"upload_session",targetId:response.uploadSessionId,requestId:request.id,metadata:{batchId:body.batchId,clientFileId:body.clientFileId}});
    return reply.code(201).send({ requestId: request.id, ...response });
  });

  app.post("/api/v1/admin/upload-sessions/:uploadSessionId/complete", async (request) => {
    const actorUserId=await adminUserId(request, sessions);
    idempotencyKey(request);
    const body = bodyObject(request);
    if (!Array.isArray(body.parts) || body.parts.length < 1 || body.parts.length > 10_000) {
      throw new ApiError("INVALID_REQUEST", 400, false, "parts list is invalid");
    }
    const parts = body.parts.map((unknownPart) => {
      if (!unknownPart || typeof unknownPart !== "object" || Array.isArray(unknownPart)) {
        throw new ApiError("INVALID_REQUEST", 400, false, "part is invalid");
      }
      const part = unknownPart as Record<string, unknown>;
      if (!Number.isInteger(part.partNumber) || Number(part.partNumber) < 1) {
        throw new ApiError("INVALID_REQUEST", 400, false, "partNumber is invalid");
      }
      return { partNumber: Number(part.partNumber), etag: stringField(part, "etag", 256) };
    });
    const uploadSessionId=pathId(request,"uploadSessionId");
    const response=await ingestion.completeUploadSession(uploadSessionId, parts);
    await audit?.record({actorType:"admin",actorId:actorUserId,action:"upload_session_completed",targetType:"upload_session",targetId:uploadSessionId,requestId:request.id,metadata:{partCount:parts.length}});
    return {
      requestId: request.id,
      ...response,
    };
  });

  app.post("/api/v1/admin/ingestion-batches/:batchId/finalize", async (request, reply) => {
    const actorUserId=await adminUserId(request, sessions);
    idempotencyKey(request);
    const batchId=pathId(request,"batchId");
    const response = await ingestion.finalizeBatch(batchId, request.id);
    await audit?.record({actorType:"admin",actorId:actorUserId,action:"ingestion_batch_finalized",targetType:"ingestion_batch",targetId:batchId,requestId:request.id,metadata:{status:response.status}});
    return reply.code(202).send({ requestId: request.id, ...response });
  });

  app.post("/api/v1/admin/ingestion-batches/:batchId/cancel", async (request) => {
    const actorUserId=await adminUserId(request, sessions);
    idempotencyKey(request);
    const batchId=pathId(request,"batchId");
    const response=await ingestion.cancelBatch(batchId);
    await audit?.record({actorType:"admin",actorId:actorUserId,action:"ingestion_batch_cancelled",targetType:"ingestion_batch",targetId:batchId,requestId:request.id});
    return {
      requestId: request.id,
      ...response,
    };
  });

  app.post("/api/v1/admin/ingestion-jobs/:jobId/retry", async (request, reply) => {
    const actorUserId=await adminUserId(request, sessions);
    idempotencyKey(request);
    const jobId=pathId(request,"jobId");
    const response = await ingestion.retryJob(jobId, request.id);
    await audit?.record({actorType:"admin",actorId:actorUserId,action:"ingestion_job_retried",targetType:"processing_job",targetId:jobId,requestId:request.id});
    return reply.code(202).send({ requestId: request.id, ...response });
  });

  app.post("/api/v1/admin/content-versions/:contentVersionId/publish", async (request) => {
    const actorUserId = await adminUserId(request, sessions);
    idempotencyKey(request);
    const body = bodyObject(request);
    const expected = body.expectedCurrentContentVersion;
    if (expected !== null && (!Number.isInteger(expected) || Number(expected) < 1)) {
      throw new ApiError("INVALID_REQUEST", 400, false, "expectedCurrentContentVersion is invalid");
    }
    return {
      requestId: request.id,
      ...(await ingestion.publishContentVersion(
        pathId(request, "contentVersionId"),
        {
          reviewId: stringField(body, "reviewId", 128),
          expectedCurrentContentVersion: expected === null ? null : Number(expected),
        },
        actorUserId,
        request.id,
      )),
    };
  });

  app.post("/api/v1/admin/content-versions/:contentVersionId/rollback", async (request) => {
    const actorUserId = await adminUserId(request, sessions);
    idempotencyKey(request);
    const body = bodyObject(request);
    if (!Number.isInteger(body.targetContentVersion) || Number(body.targetContentVersion) < 1) {
      throw new ApiError("INVALID_REQUEST", 400, false, "targetContentVersion is invalid");
    }
    return {
      requestId: request.id,
      ...(await ingestion.rollbackContentVersion(
        pathId(request, "contentVersionId"),
        {
          targetContentVersion: Number(body.targetContentVersion),
          reason: stringField(body, "reason", 1000),
        },
        actorUserId,
        request.id,
      )),
    };
  });
}
