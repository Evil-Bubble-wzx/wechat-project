import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import pg from "pg";

import { createApp } from "../src/api/app.ts";
import type { RankingServicePort } from "../src/api/ranking-routes.ts";
import type { SessionServicePort } from "../src/api/session-routes.ts";
import type { AuthenticatedSession, CurrentUser, SessionTokenResponse } from "../src/auth/session-service.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { AuditService } from "../src/observability/audit-service.ts";
import { MetricsRegistry, OperationalMetricsCollector } from "../src/observability/metrics.ts";

const { Pool } = pg;
const schema = `observability_test_${randomBytes(8).toString("hex")}`;
if (!/^observability_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid schema");
const config = loadConfig();
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({ connectionString: config.databaseUrl, max: 3, options: `-c search_path=${schema},public` });
const userId = "11111111-1111-4111-8111-111111111111";

class SmokeSession implements SessionServicePort {
  async createWechatSession(): Promise<SessionTokenResponse> { throw new Error("unused"); }
  async refreshSession(): Promise<SessionTokenResponse> { throw new Error("unused"); }
  async authenticateAccessToken(token: string): Promise<AuthenticatedSession> {
    assert.equal(token, "observability-access-token");
    return { userId, sessionId: "22222222-2222-4222-8222-222222222222" };
  }
  async revokeSession(): Promise<void> { throw new Error("unused"); }
  async getCurrentUser(): Promise<CurrentUser> { throw new Error("unused"); }
}

class SmokeRanking implements RankingServicePort {
  async options() { return { timezone: "Asia/Shanghai", minimumCohortSize: 10, ruleVersion: "quiz-score-v1", campuses: [], periodTypes: [], periods: { week: [], month: [] }, grades: [], levels: [] }; }
  async rankings() { return { status: "unavailable" as const, timezone: "Asia/Shanghai", filters: { campusId: "a", periodType: "rolling7" as const, periodKey: "2026-09-17/2026-09-24", grade: null, level: null }, ruleVersion: "quiz-score-v1", periodType: "rolling7" as const, periodKey: "2026-09-17/2026-09-24", startsAt: "2026-09-17T00:00:00.000Z", endsAt: "2026-09-24T00:00:00.000Z", generatedAt: null, minimumCohortSize: 10, cohortSize: 0, items: [], currentUser: null, nextCursor: null }; }
  async detail(): Promise<never> { throw new Error("unused"); }
}

async function main(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  try {
    await migrateUp(pool, { schema });
    const metrics = new MetricsRegistry();
    const app = createApp({
      appEnv: "test",
      sessionService: new SmokeSession(),
      rankingService: new SmokeRanking(),
      auditService: new AuditService(pool),
      metrics,
      operationalMetrics: new OperationalMetricsCollector(pool),
      metricsBearerToken: "observability-smoke-token",
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rankings?campusId=a&periodType=rolling7&grade=all&level=all",
      headers: { authorization: "Bearer observability-access-token" },
    });
    assert.equal(response.statusCode, 200);
    const requestId = response.json().requestId as string;
    const audit = await pool.query<{ action: string; request_id: string; metadata: Record<string, unknown> }>(
      "SELECT action,request_id,metadata FROM audit_events WHERE request_id=$1",
      [requestId],
    );
    assert.equal(audit.rows[0]?.action, "ranking_list_read");
    assert.equal(audit.rows[0]?.request_id, requestId);
    assert.deepEqual(audit.rows[0]?.metadata, {
      campusId: "a",
      periodType: "rolling7",
      periodKey: null,
      grade: "all",
      level: "all",
      status: "unavailable",
      resultCount: 0,
    });
    await assert.rejects(
      pool.query("UPDATE audit_events SET action='tampered' WHERE request_id=$1", [requestId]),
      /append-only/,
    );
    const exposed = await app.inject({
      method: "GET",
      url: "/internal/metrics",
      headers: { authorization: "Bearer observability-smoke-token" },
    });
    assert.equal(exposed.statusCode, 200);
    assert.match(exposed.body, /tingyue_ranking_queries_total\{outcome="unavailable",error_code="NONE"\} 1/);
    assert.match(exposed.body, /tingyue_ranking_rebuild_queue_depth 0/);
    assert.doesNotMatch(exposed.body, /observability-(?:access|smoke)-token/);
    await app.close();
    process.stdout.write(`observability.smoke.passed requestId=${requestId} audit=append-only metrics=protected\n`);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
