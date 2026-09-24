import { randomUUID, timingSafeEqual } from "node:crypto";

import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";

import { ApiError } from "./errors.ts";
import { registerContentRoutes } from "./content-routes.ts";
import { registerQuizRoutes } from "./quiz-routes.ts";
import { registerRankingRoutes, type RankingServicePort } from "./ranking-routes.ts";
import { registerIngestionRoutes } from "./ingestion-routes.ts";
import { registerSessionRoutes, type SessionServicePort } from "./session-routes.ts";
import type { IngestionService } from "../ingestion/service.ts";
import type { ContentService } from "../content/service.ts";
import type { QuizService } from "../quiz/service.ts";
import type { AuditService } from "../observability/audit-service.ts";
import type { MetricsRegistry, OperationalMetricsCollector } from "../observability/metrics.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";

export type ReadinessCheck = {
  name: string;
  check: () => Promise<void>;
};

export type CreateAppOptions = {
  logger?: boolean;
  readinessChecks?: ReadinessCheck[];
  sessionService?: SessionServicePort;
  ingestionService?: IngestionService;
  contentService?: ContentService;
  quizService?: QuizService;
  rankingService?: RankingServicePort;
  auditService?: AuditService;
  metrics?: MetricsRegistry;
  operationalMetrics?: OperationalMetricsCollector;
  metricsBearerToken?: string;
  appEnv?: "local" | "dev" | "test" | "prod";
  rateLimiter?: RateLimiterPort;
};

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const requestState = new WeakMap<FastifyRequest, { startedAt: bigint; errorCode: string }>();
  const app = Fastify({
    logger: options.logger
      ? {
          base: { service: "tingyue-api", environment: options.appEnv ?? "local" },
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers['idempotency-key']",
              "res.headers['set-cookie']",
            ],
            censor: "[REDACTED]",
          },
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
  });
  const readinessChecks = options.readinessChecks ?? [];

  app.addHook("onRequest", async (request) => {
    requestState.set(request, { startedAt: process.hrtime.bigint(), errorCode: "NONE" });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Request-Id", request.id);
    return payload;
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      const state = requestState.get(request);
      if (state) state.errorCode = error.code;
      return reply.code(error.statusCode).send({
        requestId: request.id,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details,
        },
      });
    }

    const state = requestState.get(request);
    if (state) state.errorCode = "INTERNAL_ERROR";
    request.log.error(
      { event: "http.request.unhandled_error", requestId: request.id, errorName: error instanceof Error ? error.name : "UnknownError", err: error },
      "unhandled API error",
    );
    return reply.code(500).send({
      requestId: request.id,
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred.",
        retryable: true,
        details: null,
      },
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    const state = requestState.get(request);
    const durationMs = state
      ? Number(process.hrtime.bigint() - state.startedAt) / 1_000_000
      : 0;
    const route = request.routeOptions.url ?? "unmatched";
    const log: Record<string, unknown> = {
      event: "http.request.completed",
      requestId: request.id,
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs: Number(durationMs.toFixed(3)),
      errorCode: state?.errorCode ?? "NONE",
    };
    if (route.startsWith("/api/v1/ranking")) {
      const query = request.query as Record<string, unknown>;
      log.rankingFilters = {
        campusId: query.campusId,
        periodType: query.periodType,
        periodKey: query.periodKey,
        grade: query.grade,
        level: query.level,
      };
    }
    request.log.info(log, "HTTP request completed");
    options.metrics?.observeHttp({
      route,
      method: request.method,
      statusCode: reply.statusCode,
      errorCode: state?.errorCode ?? "NONE",
      durationSeconds: durationMs / 1000,
    });
    requestState.delete(request);
  });

  app.get("/health/live", async () => ({
    status: "ok",
    service: "tingyue-api",
    timestamp: new Date().toISOString(),
  }));

  app.get("/health/ready", async (request, reply) => {
    const results = await Promise.all(
      readinessChecks.map(async ({ name, check }) => {
        try {
          await check();
          return { name, status: "ok" as const };
        } catch {
          return { name, status: "error" as const };
        }
      }),
    );
    const ready = results.every((result) => result.status === "ok");

    if (!ready) {
      return reply.code(503).send({
        requestId: request.id,
        status: "not-ready",
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "A required dependency is unavailable.",
          retryable: true,
          details: null,
        },
        dependencies: results,
      });
    }

    return {
      status: "ready",
      dependencies: results,
    };
  });

  if (options.metrics && options.operationalMetrics && options.metricsBearerToken) {
    app.get("/internal/metrics", async (request, reply) => {
      const authorization = request.headers.authorization;
      const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      const expected = options.metricsBearerToken!;
      const suppliedBytes = Buffer.from(supplied);
      const expectedBytes = Buffer.from(expected);
      if (
        suppliedBytes.length !== expectedBytes.length
        || !timingSafeEqual(suppliedBytes, expectedBytes)
      ) {
        throw new ApiError("UNAUTHENTICATED", 401, false, "Metrics bearer token is required");
      }
      const body = options.metrics!.render() + await options.operationalMetrics!.render();
      return reply.type("text/plain; version=0.0.4; charset=utf-8").send(body);
    });
  }

  if (options.sessionService) {
    registerSessionRoutes(app, options.sessionService, options.auditService, options.rateLimiter);
  }
  if (options.ingestionService) {
    if (!options.sessionService?.assertContentAdmin) {
      throw new Error("Ingestion routes require a session service with admin authorization");
    }
    registerIngestionRoutes(
      app,
      options.ingestionService,
      options.sessionService as SessionServicePort & {
        assertContentAdmin(userId: string): Promise<void>;
      },
      options.auditService,
    );
  }
  if (options.contentService) {
    if (!options.sessionService) throw new Error("Content routes require a session service");
    registerContentRoutes(app, options.contentService, options.sessionService, options.auditService);
  }
  if (options.quizService) {
    if (!options.sessionService) throw new Error("Quiz routes require a session service");
    registerQuizRoutes(app, options.quizService, options.sessionService, options.auditService, options.metrics, options.rateLimiter);
  }
  if (options.rankingService) {
    if (!options.sessionService) throw new Error("Ranking routes require a session service");
    registerRankingRoutes(app, options.rankingService, options.sessionService, options.auditService, options.metrics, options.rateLimiter);
  }

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      requestId: request.id,
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "The requested route does not exist.",
        retryable: false,
        details: null,
      },
    });
  });

  return app;
}
