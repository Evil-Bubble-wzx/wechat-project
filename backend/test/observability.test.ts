import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { createApp } from "../src/api/app.ts";
import { AuditService } from "../src/observability/audit-service.ts";
import { MetricsRegistry, OperationalMetricsCollector } from "../src/observability/metrics.ts";

function metricsPool(): Pool {
  return {
    async query() {
      return {
        rows: [{
          ingestion_queued: "2",
          ingestion_retry: "1",
          ingestion_dead: "0",
          ingestion_oldest_seconds: "12.5",
          review_backlog: "3",
          uploads_total: "10",
          uploads_completed: "8",
          ranking_pending: "1",
          ranking_failed: "0",
          ranking_oldest_seconds: "4.5",
          ranking_build_seconds: "0.125",
          ranking_source_lag_seconds: "2",
          ingestion_processing_seconds: "1.25",
        }],
      };
    },
  } as unknown as Pool;
}

test("protected Prometheus endpoint exposes request, domain and operational metrics", async () => {
  const metrics = new MetricsRegistry();
  metrics.incrementDomain("tingyue_quiz_submissions_total", "rejected", "QUIZ_PACKAGE_MISMATCH");
  const app = createApp({
    metrics,
    operationalMetrics: new OperationalMetricsCollector(metricsPool()),
    metricsBearerToken: "observability-test-token",
  });
  await app.inject({ method: "GET", url: "/health/live" });
  const denied = await app.inject({ method: "GET", url: "/internal/metrics" });
  assert.equal(denied.statusCode, 401);
  const response = await app.inject({
    method: "GET",
    url: "/internal/metrics",
    headers: { authorization: "Bearer observability-test-token" },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^text\/plain/);
  assert.match(response.body, /tingyue_http_requests_total/);
  assert.match(response.body, /tingyue_http_request_duration_seconds_bucket/);
  assert.match(response.body, /tingyue_quiz_submissions_total\{outcome="rejected",error_code="QUIZ_PACKAGE_MISMATCH"\} 1/);
  assert.match(response.body, /tingyue_ingestion_queue_depth 2/);
  assert.match(response.body, /tingyue_ranking_snapshot_build_duration_seconds 0.125/);
  assert.doesNotMatch(response.body, /observability-test-token/);
  await app.close();
});

test("audit records contain correlation metadata without requiring credentials", async () => {
  let parameters: unknown[] | undefined;
  const pool = {
    async query(_sql: string, values?: unknown[]) {
      parameters = values;
      return { rows: [] };
    },
  } as unknown as Pool;
  const audit = new AuditService(pool);
  await audit.record({
    actorType: "user",
    actorId: "user-001",
    action: "ranking_list_read",
    targetType: "ranking_snapshot",
    targetId: "a:rolling7:latest",
    requestId: "request-001",
    metadata: { campusId: "a", resultCount: 10 },
  });
  const serialized = JSON.stringify(parameters);
  assert.match(serialized, /request-001/);
  assert.match(serialized, /resultCount/);
  assert.doesNotMatch(serialized, /Bearer|refreshToken|openid|selectedOptions/);
});
