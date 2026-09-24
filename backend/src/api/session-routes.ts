import type { FastifyInstance, FastifyRequest } from "fastify";

import type {
  AuthenticatedSession,
  CurrentUser,
  SessionTokenResponse,
} from "../auth/session-service.ts";
import type { AuditService } from "../observability/audit-service.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
import { ApiError } from "./errors.ts";

export interface SessionServicePort {
  createWechatSession(input: {
    code: string;
    deviceId?: string;
    idempotencyKey: string;
  }): Promise<SessionTokenResponse>;
  refreshSession(input: {
    refreshToken: string;
    idempotencyKey: string;
    requestId?: string;
  }): Promise<SessionTokenResponse>;
  authenticateAccessToken(token: string): Promise<AuthenticatedSession>;
  revokeSession(input: { accessToken: string; idempotencyKey: string }): Promise<void>;
  getCurrentUser(session: AuthenticatedSession): Promise<CurrentUser>;
  assertContentAdmin?(userId: string): Promise<void>;
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new ApiError(
      "INVALID_REQUEST",
      400,
      false,
      "Idempotency-Key must contain 8 to 128 characters",
      { field: "Idempotency-Key" },
    );
  }
  return value;
}

function readBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new ApiError("UNAUTHENTICATED", 401, false, "Bearer access token is required");
  }
  return authorization.slice(7);
}

function readObjectBody(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "JSON object body is required");
  }
  return request.body as Record<string, unknown>;
}

async function authenticate(
  request: FastifyRequest,
  service: SessionServicePort,
): Promise<AuthenticatedSession> {
  return service.authenticateAccessToken(readBearerToken(request));
}

export function registerSessionRoutes(
  app: FastifyInstance,
  service: SessionServicePort,
  audit?: AuditService,
  rateLimiter?: RateLimiterPort,
): void {
  app.post("/api/v1/session/wechat", async (request, reply) => {
    await rateLimiter?.consume("session-login", request.ip, 10, 60);
    const body = readObjectBody(request);
    if (typeof body.code !== "string" || body.code.length < 1 || body.code.length > 256) {
      throw new ApiError("INVALID_REQUEST", 400, false, "code is required", {
        field: "code",
      });
    }
    if (
      body.deviceId !== undefined &&
      (typeof body.deviceId !== "string" ||
        body.deviceId.length < 8 ||
        body.deviceId.length > 128)
    ) {
      throw new ApiError("INVALID_REQUEST", 400, false, "deviceId is invalid", {
        field: "deviceId",
      });
    }
    const response = await service.createWechatSession({
      code: body.code,
      deviceId: body.deviceId as string | undefined,
      idempotencyKey: readIdempotencyKey(request),
    });
    await audit?.record({
      actorType: "user",
      actorId: response.userId,
      action: "session_login",
      targetType: "session",
      targetId: response.sessionId,
      requestId: request.id,
      metadata: { provider: "wechat" },
    });
    return reply.code(201).send({ requestId: request.id, ...response });
  });

  app.post("/api/v1/session/refresh", async (request) => {
    await rateLimiter?.consume("session-refresh", request.ip, 30, 60);
    const body = readObjectBody(request);
    if (
      typeof body.refreshToken !== "string" ||
      body.refreshToken.length < 32 ||
      body.refreshToken.length > 4096
    ) {
      throw new ApiError("INVALID_REQUEST", 400, false, "refreshToken is invalid", {
        field: "refreshToken",
      });
    }
    const response = await service.refreshSession({
      refreshToken: body.refreshToken,
      idempotencyKey: readIdempotencyKey(request),
      requestId: request.id,
    });
    await audit?.record({
      actorType: "user",
      actorId: response.userId,
      action: "session_refresh",
      targetType: "session",
      targetId: response.sessionId,
      requestId: request.id,
    });
    return { requestId: request.id, ...response };
  });

  app.delete("/api/v1/session/current", async (request) => {
    const idempotencyKey = readIdempotencyKey(request);
    const accessToken = readBearerToken(request);
    const session = await service.authenticateAccessToken(accessToken);
    await service.revokeSession({ accessToken, idempotencyKey });
    await audit?.record({
      actorType: "user",
      actorId: session.userId,
      action: "session_logout",
      targetType: "session",
      targetId: session.sessionId,
      requestId: request.id,
    });
    return { requestId: request.id, status: "revoked" };
  });

  app.get("/api/v1/me", async (request) => {
    const session = await authenticate(request, service);
    const user = await service.getCurrentUser(session);
    return { requestId: request.id, ...user };
  });
}
