import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ContentService } from "../content/service.ts";
import type { AuditService } from "../observability/audit-service.ts";
import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";

function bearer(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length <= 7) {
    throw new ApiError("UNAUTHENTICATED", 401, false, "Bearer access token is required");
  }
  return value.slice(7);
}

export function registerContentRoutes(
  app: FastifyInstance,
  content: ContentService,
  sessions: SessionServicePort,
  audit?: AuditService,
): void {
  app.get("/api/v1/works", async (request) => {
    const session = await sessions.authenticateAccessToken(bearer(request));
    const query = request.query as Record<string, unknown>;
    const cursor = query.cursor;
    const rawLimit = query.limit;
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (
      (cursor !== undefined && typeof cursor !== "string") ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new ApiError("INVALID_REQUEST", 400, false, "Cursor or limit is invalid");
    }
    const response = await content.listWorks(cursor as string | undefined, limit);
    await audit?.record({
      actorType: "user", actorId: session.userId, action: "content_list_read",
      targetType: "work_collection", targetId: "published", requestId: request.id,
      metadata: { resultCount: response.items.length, hasNextPage: response.nextCursor !== null },
    });
    return {
      requestId: request.id,
      ...response,
    };
  });

  app.get("/api/v1/works/:workId", async (request) => {
    const session = await sessions.authenticateAccessToken(bearer(request));
    const { workId } = request.params as { workId: string };
    const response = await content.getWork(workId);
    await audit?.record({
      actorType: "user", actorId: session.userId, action: "content_work_read",
      targetType: "work", targetId: workId, requestId: request.id,
    });
    return { requestId: request.id, ...response };
  });

  app.get("/api/v1/pieces/:pieceId/manifest", async (request) => {
    const session = await sessions.authenticateAccessToken(bearer(request));
    const { pieceId } = request.params as { pieceId: string };
    const query = request.query as Record<string, unknown>;
    const version = query.contentVersion === undefined ? undefined : Number(query.contentVersion);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      throw new ApiError("INVALID_REQUEST", 400, false, "contentVersion is invalid");
    }
    const response = await content.getManifest(pieceId, version);
    await audit?.record({
      actorType: "user", actorId: session.userId, action: "content_manifest_read",
      targetType: "piece", targetId: pieceId, requestId: request.id,
      metadata: { contentVersion: response.contentVersion, assetCount: response.assets.length },
    });
    return {
      requestId: request.id,
      ...response,
    };
  });
}
