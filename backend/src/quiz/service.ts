import { createHash } from "node:crypto";

import type { Pool } from "pg";

export type QuizAttemptInput = {
  schemaVersion: 1;
  attemptId: string;
  workId: string;
  pieceId: string;
  contentVersion: number;
  quizVersion: number;
  questionIds: string[];
  selectedOptions: number[];
  startedAt: string;
  submittedAt: string;
};

export type QuizAttemptResult =
  | {
      attemptId: string;
      status: "server_verified";
      score: number;
      mastery: boolean;
      verifiedAt: string;
    }
  | {
      attemptId: string;
      status: "rejected";
      error: {
        code: "CONTENT_VERSION_UNAVAILABLE" | "QUIZ_PACKAGE_MISMATCH" | "QUIZ_ATTEMPT_REJECTED";
        message: string;
        retryable: false;
        details: unknown;
      };
    };

function requestHash(input: QuizAttemptInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function rejected(
  attemptId: string,
  code: "CONTENT_VERSION_UNAVAILABLE" | "QUIZ_PACKAGE_MISMATCH" | "QUIZ_ATTEMPT_REJECTED",
  message: string,
  details: unknown = null,
): QuizAttemptResult {
  return {
    attemptId,
    status: "rejected",
    error: { code, message, retryable: false, details },
  };
}

export class QuizService {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async submit(userId: string, input: QuizAttemptInput): Promise<QuizAttemptResult> {
    const hash = requestHash(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `quiz-attempt:${userId}:${input.attemptId}`,
      ]);
      const existing = await client.query<{
        request_hash: string;
        status: "server_verified" | "rejected";
        score: number | null;
        mastery: boolean | null;
        rejection_code: "QUIZ_PACKAGE_MISMATCH" | "QUIZ_ATTEMPT_REJECTED" | null;
        verified_at: Date | null;
      }>(
        `SELECT request_hash, status, score, mastery, rejection_code, verified_at
         FROM quiz_attempts WHERE user_id = $1 AND attempt_id = $2`,
        [userId, input.attemptId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        await client.query("COMMIT");
        if (row.request_hash.trim() !== hash) {
          return rejected(
            input.attemptId,
            "QUIZ_ATTEMPT_REJECTED",
            "attemptId was already submitted with different answers",
          );
        }
        if (row.status === "rejected") {
          return rejected(
            input.attemptId,
            row.rejection_code ?? "QUIZ_ATTEMPT_REJECTED",
            "Quiz attempt was rejected",
          );
        }
        return {
          attemptId: input.attemptId,
          status: "server_verified",
          score: row.score!,
          mastery: row.mastery!,
          verifiedAt: row.verified_at!.toISOString(),
        };
      }

      const piece = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pieces p
           JOIN works w ON w.id = p.work_id
           JOIN content_versions cv ON cv.piece_id = p.id
           WHERE p.id = $1 AND w.id = $2 AND cv.content_version = $3
             AND cv.status = 'published' AND p.current_content_version_id = cv.id
         ) AS exists`,
        [input.pieceId, input.workId, input.contentVersion],
      );
      if (!piece.rows[0]?.exists) {
        await client.query("COMMIT");
        return rejected(
          input.attemptId,
          "CONTENT_VERSION_UNAVAILABLE",
          "Content version is not the current published version",
        );
      }
      const packageResult = await client.query<{
        id: string;
        mastery_threshold: number;
      }>(
        `SELECT id, mastery_threshold FROM quiz_packages
         WHERE piece_id = $1 AND content_version = $2 AND quiz_version = $3
           AND status = 'published'`,
        [input.pieceId, input.contentVersion, input.quizVersion],
      );
      const quizPackage = packageResult.rows[0];
      if (!quizPackage) {
        await client.query("COMMIT");
        return rejected(
          input.attemptId,
          "QUIZ_PACKAGE_MISMATCH",
          "Quiz package version is unavailable",
        );
      }
      const questions = await client.query<{
        id: string;
        question_id: string;
        option_count: number;
        correct_option: number;
      }>(
        `SELECT id, question_id, jsonb_array_length(options) AS option_count, correct_option
         FROM quiz_questions WHERE quiz_package_id = $1 ORDER BY sort_order`,
        [quizPackage.id],
      );
      const expectedIds = questions.rows.map(({ question_id }) => question_id);
      const questionSetMatches =
        expectedIds.length === input.questionIds.length &&
        expectedIds.every((questionId, index) => questionId === input.questionIds[index]);
      const selectionsValid =
        input.selectedOptions.length === questions.rows.length &&
        input.selectedOptions.every(
          (selection, index) =>
            Number.isInteger(selection) && selection >= 0 && selection < questions.rows[index]!.option_count,
        );
      if (!questionSetMatches || !selectionsValid) {
        const rejectionCode = questionSetMatches
          ? "QUIZ_ATTEMPT_REJECTED"
          : "QUIZ_PACKAGE_MISMATCH";
        await client.query(
          `INSERT INTO quiz_attempts (
             user_id, attempt_id, quiz_package_id, started_at, submitted_at,
             status, rejection_code, request_hash
           ) VALUES ($1, $2, $3, $4, $5, 'rejected', $6, $7)`,
          [
            userId,
            input.attemptId,
            quizPackage.id,
            input.startedAt,
            input.submittedAt,
            rejectionCode,
            hash,
          ],
        );
        await client.query("COMMIT");
        return rejected(
          input.attemptId,
          rejectionCode,
          questionSetMatches ? "One or more selected options are invalid" : "Question set or order differs from the package",
        );
      }

      const correctCount = questions.rows.reduce(
        (count, question, index) =>
          count + (input.selectedOptions[index] === question.correct_option ? 1 : 0),
        0,
      );
      const score = Math.round((correctCount / questions.rows.length) * 100);
      const mastery = score >= quizPackage.mastery_threshold;
      const attempt = await client.query<{ id: string; verified_at: Date }>(
        `INSERT INTO quiz_attempts (
           user_id, attempt_id, quiz_package_id, started_at, submitted_at,
           status, score, mastery, request_hash, verified_at
         ) VALUES ($1, $2, $3, $4, $5, 'server_verified', $6, $7, $8, now())
         RETURNING id, verified_at`,
        [
          userId,
          input.attemptId,
          quizPackage.id,
          input.startedAt,
          input.submittedAt,
          score,
          mastery,
          hash,
        ],
      );
      for (const [index, question] of questions.rows.entries()) {
        const selected = input.selectedOptions[index]!;
        await client.query(
          `INSERT INTO quiz_answers (
             quiz_attempt_id, quiz_question_id, selected_option, is_correct
           ) VALUES ($1, $2, $3, $4)`,
          [attempt.rows[0]!.id, question.id, selected, selected === question.correct_option],
        );
      }
      await client.query(
        `INSERT INTO ranking_rebuild_events (quiz_attempt_id)
         VALUES ($1)
         ON CONFLICT (quiz_attempt_id) DO NOTHING`,
        [attempt.rows[0]!.id],
      );
      await client.query("COMMIT");
      return {
        attemptId: input.attemptId,
        status: "server_verified",
        score,
        mastery,
        verifiedAt: attempt.rows[0]!.verified_at.toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
