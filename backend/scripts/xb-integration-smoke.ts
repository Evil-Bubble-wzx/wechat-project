import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { createApp } from "../src/api/app.ts";
import { SessionService } from "../src/auth/session-service.ts";
import { StubWechatIdentityProvider } from "../src/auth/wechat-provider.ts";
import { loadConfig } from "../src/config.ts";
import { ContentService } from "../src/content/service.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { AuditService } from "../src/observability/audit-service.ts";
import { QuizService } from "../src/quiz/service.ts";
import { RankingAggregationService } from "../src/ranking/aggregation-service.ts";
import { RankingQueryService } from "../src/ranking/query-service.ts";

const { Pool } = pg;
const schema = `xb_test_${randomBytes(8).toString("hex")}`;
if (!/^xb_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid X/B schema");
const baseConfig = loadConfig();
const config = loadConfig({ APP_ENV: "test", DATABASE_URL: baseConfig.databaseUrl, WECHAT_PROVIDER: "stub" });
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({ connectionString: config.databaseUrl, max: 5, options: `-c search_path=${schema},public` });

async function seedQuiz(): Promise<void> {
  await pool.query("INSERT INTO works (id,title,author,ranking_category,status,access_type) VALUES ('xb-work','X/B Book','Test Author','fiction','published','free')");
  await pool.query("INSERT INTO pieces (id,work_id,title,status,access_type,word_count,ranking_level) VALUES ('xb-piece','xb-work','X/B Piece','published','free',1200,3.2)");
  const content = await pool.query<{ id: string }>(
    `INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at)
     VALUES ('xb-piece',1,'published',true,$1,now()) RETURNING id`,
    ["a".repeat(64)],
  );
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='xb-piece'", [content.rows[0]!.id]);
  const quiz = await pool.query<{ id: string }>(
    `INSERT INTO quiz_packages (piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at)
     VALUES ('xb-piece',1,1,$1,'published',80,now()) RETURNING id`,
    ["b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO quiz_questions (quiz_package_id,question_id,prompt,options,correct_option,sort_order)
     VALUES ($1,'q1','Question 1','["A","B","C"]',1,0),($1,'q2','Question 2','["A","B","C"]',2,1)`,
    [quiz.rows[0]!.id],
  );
}

type WxRequestOptions = {
  url: string;
  method?: string;
  header?: Record<string, string>;
  data?: unknown;
  success(response: unknown): void;
  fail(error: unknown): void;
};

async function main(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  let app: ReturnType<typeof createApp> | undefined;
  try {
    await migrateUp(pool, { schema });
    await seedQuiz();
    const sessionService = new SessionService(pool, new StubWechatIdentityProvider(), config);
    const rankingQuery = new RankingQueryService(pool, config.auth.identityHashKeyBase64);
    app = createApp({
      appEnv: "test",
      sessionService,
      contentService: new ContentService(pool, {} as S3Client, config.auth.identityHashKeyBase64),
      quizService: new QuizService(pool),
      rankingService: rankingQuery,
      auditService: new AuditService(pool),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const storage = new Map<string, unknown>();
    storage.set("tingyue.dev.apiBaseUrl", address);
    const wx = {
      isBrowserPreview: false,
      getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
      getExtConfigSync: () => ({}),
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
      removeStorageSync: (key: string) => storage.delete(key),
      login: ({ success }: { success(value: { code: string }): void }) => success({ code: "real-code-not-used-in-test" }),
      request: (options: WxRequestOptions) => {
        void (async () => {
          try {
            const response = await fetch(options.url, {
              method: options.method ?? "GET",
              headers: options.header,
              body: options.data === undefined ? undefined : JSON.stringify(options.data),
            });
            const text = await response.text();
            options.success({ statusCode: response.status, data: text ? JSON.parse(text) : null, header: Object.fromEntries(response.headers.entries()) });
          } catch (error) { options.fail(error); }
        })();
      },
    };
    (globalThis as unknown as { wx: typeof wx }).wx = wx;
    const require = createRequire(import.meta.url);
    const miniappApi = require("../../miniprogram/services/api.js") as {
      loginWechat(): Promise<{ userId: string }>;
      listWorks(cursor?: string, limit?: number): Promise<{ items: Array<{ workId: string }> }>;
      submitQuiz(input: Record<string, unknown>): Promise<{ attemptId: string; status: string; score?: number; mastery?: boolean; verifiedAt?: string; error?: { code: string } }>;
      rankings(input: Record<string, unknown>): Promise<{ status: string; items: unknown[] }>;
      rankingOptions(): Promise<{ ruleVersion: string }>;
      session(): Record<string, unknown>;
      storeSession(value: unknown): void;
      logout(): Promise<void>;
      isAuthenticated(): boolean;
    };

    const me = await miniappApi.loginWechat();
    await pool.query(
      `INSERT INTO user_profiles (user_id,campus_id,grade,reading_level,profile_source,source_verified_at)
       VALUES ($1,'a','3','3','admin',now())`,
      [me.userId],
    );
    await pool.query("UPDATE user_profile_versions SET effective_from=now()-interval '8 days' WHERE user_id=$1", [me.userId]);

    const works = await miniappApi.listWorks(undefined, 20);
    assert.deepEqual(works.items.map((item) => item.workId), ["xb-work"]);

    const beforeRefresh = miniappApi.session();
    miniappApi.storeSession({ ...beforeRefresh, accessToken: "forged-access-token" });
    assert.equal((await miniappApi.listWorks()).items.length, 1, "401 must refresh and retry once");
    assert.notEqual(miniappApi.session().accessToken, "forged-access-token");

    const now = new Date();
    const attempt = {
      schemaVersion: 1,
      attemptId: "xb-attempt-0001",
      workId: "xb-work",
      pieceId: "xb-piece",
      contentVersion: 1,
      quizVersion: 1,
      questionIds: ["q1", "q2"],
      selectedOptions: [1, 2],
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      submittedAt: now.toISOString(),
    };
    const verified = await miniappApi.submitQuiz(attempt);
    assert.deepEqual({ status: verified.status, score: verified.score }, { status: "server_verified", score: 100 });
    const duplicate = await miniappApi.submitQuiz(attempt);
    assert.deepEqual(
      { attemptId: duplicate.attemptId, status: duplicate.status, score: duplicate.score, mastery: duplicate.mastery, verifiedAt: duplicate.verifiedAt },
      { attemptId: verified.attemptId, status: verified.status, score: verified.score, mastery: verified.mastery, verifiedAt: verified.verifiedAt },
      "duplicate submission must preserve the same business result",
    );
    const rejected = await miniappApi.submitQuiz({ ...attempt, attemptId: "xb-attempt-0002", quizVersion: 2 });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.error?.code, "QUIZ_PACKAGE_MISMATCH");

    const startsAt = new Date(now.getTime() - 7 * 86_400_000);
    const endsAt = new Date(now.getTime() + 5_000);
    await new RankingAggregationService(pool, config.auth.identityHashKeyBase64).build({
      periodType: "rolling7",
      periodKey: `xb-${randomUUID()}`,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      campusId: "a",
      grade: null,
      readingLevel: null,
      requestId: "xb-ranking-build",
    });
    assert.equal((await miniappApi.rankingOptions()).ruleVersion, "quiz-score-v1");
    const ranking = await miniappApi.rankings({ campusId: "a", periodType: "rolling7", grade: "all", level: "all", limit: 20 });
    assert.equal(ranking.status, "cohort_too_small");
    assert.deepEqual(ranking.items, []);

    await miniappApi.logout();
    assert.equal(miniappApi.isAuthenticated(), false);
    const audit = await pool.query<{ actions: string[] }>(
      "SELECT array_agg(DISTINCT action ORDER BY action) AS actions FROM audit_events",
    );
    for (const action of ["content_list_read", "quiz_attempt_verified", "ranking_list_read", "session_login", "session_logout", "session_refresh"]) {
      assert.ok(audit.rows[0]!.actions.includes(action), `missing audit action ${action}`);
    }
    process.stdout.write("xb.integration.passed login=wechat refresh=retry content=works quiz=verified+idempotent+rejected ranking=small logout=revoked\n");
  } finally {
    if (app) await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
