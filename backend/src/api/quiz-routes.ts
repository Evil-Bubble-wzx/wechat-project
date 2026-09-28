import type { FastifyInstance, FastifyRequest } from "fastify";

import type { QuizAttemptInput, QuizService } from "../quiz/service.ts";
import type { AuditService } from "../observability/audit-service.ts";
import type { MetricsRegistry } from "../observability/metrics.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";

function parseAttempt(request: FastifyRequest): QuizAttemptInput {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new ApiError("INVALID_REQUEST", 400, false, "JSON object body is required");
  }
  const body = request.body as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "attemptId",
    "workId",
    "pieceId",
    "contentVersion",
    "quizVersion",
    "questionIds",
    "selectedOptions",
    "startedAt",
    "submittedAt",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new ApiError(
      "INVALID_REQUEST",
      400,
      false,
      "Quiz request contains forbidden or unknown fields",
    );
  }
  const strings = ["attemptId", "workId", "pieceId", "startedAt", "submittedAt"] as const;
  for (const field of strings) {
    if (typeof body[field] !== "string" || body[field].length < 1 || body[field].length > 128) {
      throw new ApiError("INVALID_REQUEST", 400, false, `${field} is invalid`, { field });
    }
  }
  if (
    body.schemaVersion !== 1 ||
    !Number.isInteger(body.contentVersion) ||
    Number(body.contentVersion) < 1 ||
    !Number.isInteger(body.quizVersion) ||
    Number(body.quizVersion) < 1 ||
    !Array.isArray(body.questionIds) ||
    !Array.isArray(body.selectedOptions) ||
    body.questionIds.length < 1 ||
    body.questionIds.length > 100 ||
    body.questionIds.length !== body.selectedOptions.length ||
    !body.questionIds.every((value) => typeof value === "string" && value.length > 0) ||
    !body.selectedOptions.every((value) => Number.isInteger(value) && Number(value) >= 0)
  ) {
    throw new ApiError("INVALID_REQUEST", 400, false, "Quiz attempt fields are invalid");
  }
  const startedAt = new Date(body.startedAt as string);
  const submittedAt = new Date(body.submittedAt as string);
  if (
    Number.isNaN(startedAt.getTime()) ||
    Number.isNaN(submittedAt.getTime()) ||
    submittedAt < startedAt
  ) {
    throw new ApiError("INVALID_REQUEST", 400, false, "Quiz timestamps are invalid");
  }
  return {
    schemaVersion: 1,
    attemptId: body.attemptId as string,
    workId: body.workId as string,
    pieceId: body.pieceId as string,
    contentVersion: Number(body.contentVersion),
    quizVersion: Number(body.quizVersion),
    questionIds: body.questionIds as string[],
    selectedOptions: body.selectedOptions as number[],
    startedAt: startedAt.toISOString(),
    submittedAt: submittedAt.toISOString(),
  };
}

export function registerQuizRoutes(
  app: FastifyInstance,
  quiz: QuizService,
  sessions: SessionServicePort,
  audit?: AuditService,
  metrics?: MetricsRegistry,
  rateLimiter?: RateLimiterPort,
): void {
  app.post("/api/v1/me/quiz-attempts", async (request) => {
    const idempotency = request.headers["idempotency-key"];
    if (typeof idempotency !== "string" || idempotency.length < 8 || idempotency.length > 128) {
      throw new ApiError("INVALID_REQUEST", 400, false, "Valid Idempotency-Key is required");
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new ApiError("UNAUTHENTICATED", 401, false, "Bearer access token is required");
    }
    const session = await sessions.authenticateAccessToken(authorization.slice(7));
    await rateLimiter?.consume("quiz-submit", session.userId, 30, 60);
    const attempt = parseAttempt(request);
    const result = await quiz.submit(session.userId, attempt);
    metrics?.incrementDomain(
      "tingyue_quiz_submissions_total",
      result.status === "server_verified" ? "verified" : "rejected",
      result.status === "rejected" ? result.error.code : "NONE",
    );
    await audit?.record({
      actorType: "user",
      actorId: session.userId,
      action: result.status === "server_verified" ? "quiz_attempt_verified" : "quiz_attempt_rejected",
      targetType: "quiz_attempt",
      targetId: result.attemptId,
      requestId: request.id,
      metadata: {
        workId: attempt.workId,
        pieceId: attempt.pieceId,
        contentVersion: attempt.contentVersion,
        quizVersion: attempt.quizVersion,
        status: result.status,
        rejectionCode: result.status === "rejected" ? result.error.code : null,
      },
    });
    return { requestId: request.id, ...result };
  });
}
