import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";

import { loadConfig } from "../src/config.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { QuizService, type QuizAttemptInput } from "../src/quiz/service.ts";

const { Pool } = pg;
const schema = `quiz_test_${randomBytes(8).toString("hex")}`;
if (!/^quiz_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid schema");
const config = loadConfig();
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 3,
  options: `-c search_path=${schema},public`,
});

async function main(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  try {
    await migrateUp(pool, { schema });
    const userId = randomUUID();
    await pool.query("INSERT INTO users (id) VALUES ($1)", [userId]);
    await pool.query("INSERT INTO works (id, title, status) VALUES ('peter-rabbit', 'Peter Rabbit', 'published')");
    await pool.query(
      "INSERT INTO pieces (id, work_id, title, status) VALUES ('peter-rabbit-01', 'peter-rabbit', 'Peter Rabbit', 'published')",
    );
    const version = await pool.query<{ id: string }>(
      `INSERT INTO content_versions (
         piece_id, content_version, status, publishable, manifest_sha256, published_at
       ) VALUES ('peter-rabbit-01', 1, 'published', true, $1, now()) RETURNING id`,
      ["a".repeat(64)],
    );
    await pool.query(
      "UPDATE pieces SET current_content_version_id = $1 WHERE id = 'peter-rabbit-01'",
      [version.rows[0]!.id],
    );
    const quizPackage = await pool.query<{ id: string }>(
      `INSERT INTO quiz_packages (
         piece_id, content_version, quiz_version, package_sha256,
         status, mastery_threshold, published_at
       ) VALUES ('peter-rabbit-01', 1, 1, $1, 'published', 80, now()) RETURNING id`,
      ["b".repeat(64)],
    );
    for (const [index, questionId, answer] of [
      [0, "PRQ-001", 0],
      [1, "PRQ-002", 1],
    ] as const) {
      await pool.query(
        `INSERT INTO quiz_questions (
           quiz_package_id, question_id, prompt, options, correct_option, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          quizPackage.rows[0]!.id,
          questionId,
          `Question ${index + 1}`,
          JSON.stringify(["A", "B", "C"]),
          answer,
          index,
        ],
      );
    }

    const service = new QuizService(pool);
    const input: QuizAttemptInput = {
      schemaVersion: 1,
      attemptId: "attempt-smoke-001",
      workId: "peter-rabbit",
      pieceId: "peter-rabbit-01",
      contentVersion: 1,
      quizVersion: 1,
      questionIds: ["PRQ-001", "PRQ-002"],
      selectedOptions: [0, 1],
      startedAt: "2026-09-24T03:00:00.000Z",
      submittedAt: "2026-09-24T03:01:00.000Z",
    };
    const verified = await service.submit(userId, input);
    assert.equal(verified.status, "server_verified");
    if (verified.status === "server_verified") {
      assert.equal(verified.score, 100);
      assert.equal(verified.mastery, true);
    }
    assert.deepEqual(await service.submit(userId, input), verified);
    const attemptReuse = await service.submit(userId, {
      ...input,
      selectedOptions: [1, 1],
    });
    assert.equal(attemptReuse.status, "rejected");
    if (attemptReuse.status === "rejected") {
      assert.equal(attemptReuse.error.code, "QUIZ_ATTEMPT_REJECTED");
    }

    const invalidOptionInput = {
      ...input,
      attemptId: "attempt-smoke-002",
      selectedOptions: [0, 99],
    };
    const invalidOption = await service.submit(userId, invalidOptionInput);
    assert.equal(invalidOption.status, "rejected");
    assert.deepEqual(await service.submit(userId, invalidOptionInput), {
      ...invalidOption,
      error:
        invalidOption.status === "rejected"
          ? { ...invalidOption.error, message: "Quiz attempt was rejected" }
          : undefined,
    });

    const packageMismatch = await service.submit(userId, {
      ...input,
      attemptId: "attempt-smoke-003",
      questionIds: ["PRQ-002", "PRQ-001"],
    });
    assert.equal(packageMismatch.status, "rejected");
    if (packageMismatch.status === "rejected") {
      assert.equal(packageMismatch.error.code, "QUIZ_PACKAGE_MISMATCH");
    }
    const versionMismatch = await service.submit(userId, {
      ...input,
      attemptId: "attempt-smoke-004",
      contentVersion: 2,
    });
    assert.equal(versionMismatch.status, "rejected");
    if (versionMismatch.status === "rejected") {
      assert.equal(versionMismatch.error.code, "CONTENT_VERSION_UNAVAILABLE");
    }
    const stored = await pool.query<{ attempts: string; answers: string }>(
      `SELECT
         (SELECT count(*)::text FROM quiz_attempts) AS attempts,
         (SELECT count(*)::text FROM quiz_answers) AS answers`,
    );
    assert.deepEqual(stored.rows[0], { attempts: "3", answers: "2" });
    process.stdout.write("quiz.smoke.passed score=server idempotent=true rejected=stable\n");
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
