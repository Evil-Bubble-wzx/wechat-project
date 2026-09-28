import { createHash, createHmac } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  RANKING_RULE_VERSION,
  selectRankingAttempts,
  scoreRankingCohort,
  type RankingAttemptFact,
  type RankingParticipantFacts,
  type RankingScoreResult,
} from "./score.ts";

export type RankingPeriodType = "rolling7" | "week" | "month" | "year";

export type RankingDimensions = {
  periodType: RankingPeriodType;
  periodKey: string;
  startsAt: string;
  endsAt: string;
  campusId: string;
  grade: string | null;
  readingLevel: string | null;
  minimumCohortSize?: number;
  requestId: string;
};

type RankingFactRow = {
  quiz_attempt_id: string;
  user_id: string;
  work_id: string;
  piece_id: string;
  title: string;
  series: string | null;
  author: string | null;
  submitted_at: Date;
  verified_at: Date;
  score: number;
  word_count: number | null;
  ranking_level: string | null;
  ranking_category: "fiction" | "nonfiction" | null;
  profile_grade: string | null;
  profile_level: string | null;
};

export type ComputedRankingEntry = RankingScoreResult & {
  userId: string;
  participantId: string;
  displayName: string;
  profileGrade: string | null;
  profileReadingLevel: string | null;
  stats: Record<string, number | null>;
  quizzes: Array<{
    quizAttemptId: string;
    workId: string;
    pieceId: string;
    title: string;
    series: string | null;
    author: string | null;
    takenAt: string;
    correctPercent: number;
    level: number | null;
    category: "fiction" | "nonfiction" | null;
    wordCount: number;
    countedInScore: boolean;
  }>;
};

export type ComputedRanking = {
  sourceMaxVerifiedAt: string | null;
  sourceFingerprint: string;
  entries: ComputedRankingEntry[];
};

export type RankingBuildResult = {
  snapshotId: string;
  status: "ready" | "cohort_too_small";
  cohortSize: number;
  minimumCohortSize: number;
  generatedAt: string;
  entries: Array<{
    rank: number;
    participantId: string;
    displayName: string;
    metric: { key: "rankingScore"; label: "Quiz Score"; value: number; unit: "points" };
  }>;
};

function asDate(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date;
}

function average(values: number[]): number | null {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function firstRowsPerWork(rows: RankingFactRow[]): RankingFactRow[] {
  const selected = selectRankingAttempts(rows.map((row) => ({
    workId: row.work_id,
    submittedAt: row.submitted_at.toISOString(),
    accuracyPercent: row.score,
    wordCount: row.word_count ?? 0,
    bookLevel: row.ranking_level === null ? null : Number(row.ranking_level),
    category: row.ranking_category,
  })));
  const keys = new Set(selected.map((attempt) => `${attempt.workId}\u0000${attempt.submittedAt}`));
  return rows.filter((row) => keys.has(`${row.work_id}\u0000${row.submitted_at.toISOString()}`));
}

function statsFor(rows: RankingFactRow[]): Record<string, number | null> {
  const selected = firstRowsPerWork(rows);
  const levels = selected
    .map((row) => row.ranking_level === null ? null : Number(row.ranking_level))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const categorized = selected.filter((row) => row.ranking_category !== null);
  const fictionPercent = categorized.length
    ? Number((categorized.filter((row) => row.ranking_category === "fiction").length / categorized.length * 100).toFixed(2))
    : null;
  const words = selected.reduce((sum, row) => sum + (row.word_count ?? 0), 0);
  const accuracy = average(selected.map((row) => row.score));
  return {
    completedBooks:selected.length,
    allBooks:selected.length,
    completedWords:words,
    allWords:words,
    completedAverageCorrect:accuracy,
    allAverageCorrect:accuracy,
    completedAverageLevel:average(levels),
    allAverageLevel:average(levels),
    completedFictionPercent:fictionPercent,
    allFictionPercent:fictionPercent,
  };
}

export class RankingAggregationService {
  private readonly pool: Pool;
  private readonly participantKey: Buffer;

  constructor(pool: Pool, participantKeyBase64: string) {
    this.pool = pool;
    this.participantKey = Buffer.from(participantKeyBase64, "base64");
    if (this.participantKey.length < 32) throw new Error("Ranking participant key must contain at least 32 bytes");
  }

  private participantId(userId: string): string {
    return `reader_${createHmac("sha256", this.participantKey).update(userId).digest("base64url").slice(0, 20)}`;
  }

  private validateDimensions(dimensions: RankingDimensions): Required<RankingDimensions> {
    const startsAt = asDate(dimensions.startsAt, "startsAt");
    const endsAt = asDate(dimensions.endsAt, "endsAt");
    if (endsAt <= startsAt) throw new Error("endsAt must be later than startsAt");
    const minimumCohortSize = dimensions.minimumCohortSize ?? 10;
    if (!Number.isInteger(minimumCohortSize) || minimumCohortSize < 1) {
      throw new Error("minimumCohortSize must be a positive integer");
    }
    if (!dimensions.periodKey.trim() || !dimensions.campusId.trim() || !dimensions.requestId.trim()) {
      throw new Error("Ranking dimensions and requestId are required");
    }
    return { ...dimensions, minimumCohortSize };
  }

  private async readFacts(client: Pool | PoolClient, dimensions: Required<RankingDimensions>): Promise<RankingFactRow[]> {
    const result = await client.query<RankingFactRow>(
      `SELECT
         qa.id AS quiz_attempt_id, qa.user_id, p.work_id, p.id AS piece_id,
         w.title, w.series, w.author, qa.submitted_at, qa.verified_at, qa.score,
         p.word_count, p.ranking_level, w.ranking_category,
         profile.grade AS profile_grade, profile.reading_level AS profile_level
       FROM quiz_attempts qa
       JOIN quiz_packages qp ON qp.id = qa.quiz_package_id
       JOIN pieces p ON p.id = qp.piece_id
       JOIN works w ON w.id = p.work_id
       JOIN LATERAL (
         SELECT campus_id, grade, reading_level
         FROM user_profile_versions upv
         WHERE upv.user_id = qa.user_id
           AND upv.effective_from <= $1
           AND (upv.effective_until IS NULL OR upv.effective_until > $1)
           AND upv.profile_source IN ('admin', 'school_sync')
           AND upv.source_verified_at IS NOT NULL
         ORDER BY upv.effective_from DESC
         LIMIT 1
       ) profile ON true
       WHERE qa.status = 'server_verified'
         AND qa.withdrawn_at IS NULL
         AND qa.submitted_at >= $1 AND qa.submitted_at < $2
         AND profile.campus_id = $3
         AND ($4::text IS NULL OR profile.grade = $4)
         AND ($5::text IS NULL OR profile.reading_level = $5)
       ORDER BY qa.user_id, qa.submitted_at, qa.id`,
      [dimensions.startsAt, dimensions.endsAt, dimensions.campusId, dimensions.grade, dimensions.readingLevel],
    );
    return result.rows;
  }

  async compute(dimensionsInput: RankingDimensions, client: Pool | PoolClient = this.pool): Promise<ComputedRanking> {
    const dimensions = this.validateDimensions(dimensionsInput);
    const rows = await this.readFacts(client, dimensions);
    const rowsByUser = new Map<string, RankingFactRow[]>();
    for (const row of rows) rowsByUser.set(row.user_id, [...(rowsByUser.get(row.user_id) ?? []), row]);
    const participants: RankingParticipantFacts[] = [...rowsByUser.entries()].map(([userId, userRows]) => ({
      participantId:userId,
      profileLevel:userRows[0]?.profile_level === null ? null : Number(userRows[0]?.profile_level),
      attempts:userRows.map((row): RankingAttemptFact => ({
        workId:row.work_id,
        submittedAt:row.submitted_at.toISOString(),
        accuracyPercent:row.score,
        wordCount:row.word_count ?? 0,
        bookLevel:row.ranking_level === null ? null : Number(row.ranking_level),
        category:row.ranking_category,
      })),
    }));
    const scores = scoreRankingCohort(participants);
    const entries = scores.map((score): ComputedRankingEntry => {
      const userRows = rowsByUser.get(score.participantId)!;
      const firstAttemptIds = new Set(firstRowsPerWork(userRows).map((row) => row.quiz_attempt_id));
      const participantId = this.participantId(score.participantId);
      return {
        ...score,
        userId:score.participantId,
        participantId,
        displayName:`Reader ${participantId.slice(-6).toUpperCase()}`,
        profileGrade:userRows[0]?.profile_grade ?? null,
        profileReadingLevel:userRows[0]?.profile_level ?? null,
        stats:statsFor(userRows),
        quizzes:userRows.map((row) => ({
          quizAttemptId:row.quiz_attempt_id,
          workId:row.work_id,
          pieceId:row.piece_id,
          title:row.title,
          series:row.series,
          author:row.author,
          takenAt:row.submitted_at.toISOString(),
          correctPercent:row.score,
          level:row.ranking_level === null ? null : Number(row.ranking_level),
          category:row.ranking_category,
          wordCount:row.word_count ?? 0,
          countedInScore:firstAttemptIds.has(row.quiz_attempt_id),
        })),
      };
    });
    const sourceMax = rows.reduce<Date | null>((latest, row) => !latest || row.verified_at > latest ? row.verified_at : latest, null);
    const sourceFingerprint = createHash("sha256").update(JSON.stringify(rows.map((row) => ({
      quizAttemptId:row.quiz_attempt_id,
      userId:row.user_id,
      workId:row.work_id,
      submittedAt:row.submitted_at.toISOString(),
      verifiedAt:row.verified_at.toISOString(),
      score:row.score,
      wordCount:row.word_count,
      rankingLevel:row.ranking_level,
      rankingCategory:row.ranking_category,
      profileGrade:row.profile_grade,
      profileLevel:row.profile_level,
    })))).digest("hex");
    return { sourceMaxVerifiedAt:sourceMax?.toISOString() ?? null, sourceFingerprint, entries };
  }

  async build(dimensionsInput: RankingDimensions): Promise<RankingBuildResult> {
    const buildStartedAt = Date.now();
    const dimensions = this.validateDimensions(dimensionsInput);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const lockKey = [dimensions.periodType,dimensions.periodKey,dimensions.campusId,dimensions.grade??"all",dimensions.readingLevel??"all",RANKING_RULE_VERSION].join(":");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ranking:${lockKey}`]);
      const computed = await this.compute(dimensions, client);
      const existing = await client.query<{
        id: string;
        status: string;
        result_status: "ready" | "cohort_too_small" | null;
        cohort_size: number;
        minimum_cohort_size: number;
        generated_at: Date | null;
        entries: RankingBuildResult["entries"];
      }>(
        `SELECT id, status, result_status, cohort_size, minimum_cohort_size, generated_at, entries
         FROM ranking_snapshots
         WHERE period_type = $1 AND period_key = $2 AND campus_id = $3
           AND grade IS NOT DISTINCT FROM $4 AND reading_level IS NOT DISTINCT FROM $5
           AND rule_version = $6 AND source_fingerprint = $7
         ORDER BY generated_at DESC NULLS LAST LIMIT 1
         FOR UPDATE`,
        [dimensions.periodType,dimensions.periodKey,dimensions.campusId,dimensions.grade,dimensions.readingLevel,RANKING_RULE_VERSION,computed.sourceFingerprint],
      );
      const ready = existing.rows[0];
      if (ready?.status === "ready" && ready.result_status && ready.generated_at) {
        await client.query("COMMIT");
        return {
          snapshotId:ready.id,
          status:ready.result_status,
          cohortSize:ready.cohort_size,
          minimumCohortSize:ready.minimum_cohort_size,
          generatedAt:ready.generated_at.toISOString(),
          entries:ready.entries,
        };
      }

      const snapshot = (await client.query<{ id: string }>(
        `INSERT INTO ranking_snapshots (
           period_type, period_key, starts_at, ends_at, campus_id, grade, reading_level,
           rule_version, status, minimum_cohort_size, algorithm_metadata, source_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'building',$9,$10,$11) RETURNING id`,
        [dimensions.periodType,dimensions.periodKey,dimensions.startsAt,dimensions.endsAt,dimensions.campusId,dimensions.grade,dimensions.readingLevel,RANKING_RULE_VERSION,dimensions.minimumCohortSize,JSON.stringify({weights:{completion:0.3,words:0.15,accuracy:0.25,challenge:0.15,growth:0.1,breadth:0.05}}),computed.sourceFingerprint],
      )).rows[0]!;
      const resultStatus = computed.entries.length < dimensions.minimumCohortSize ? "cohort_too_small" : "ready";
      const publicEntries: RankingBuildResult["entries"] = resultStatus === "ready" ? computed.entries.map((entry) => ({
        rank:entry.rank,
        participantId:entry.participantId,
        displayName:entry.displayName,
        metric:{key:"rankingScore",label:"Quiz Score",value:entry.score,unit:"points"},
      })) : [];

      if (resultStatus === "ready") {
        for (const entry of computed.entries) {
          await client.query(
            `INSERT INTO ranking_snapshot_entries (
               snapshot_id, user_id, participant_id, display_name, rank, score,
               completed_books, total_words, adjusted_accuracy, score_breakdown, stats,
               profile_grade, profile_reading_level
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [snapshot.id,entry.userId,entry.participantId,entry.displayName,entry.rank,entry.score,entry.completedBooks,entry.totalWords,entry.adjustedAccuracy,JSON.stringify(entry.breakdown),JSON.stringify(entry.stats),entry.profileGrade,entry.profileReadingLevel],
          );
          for (const quiz of entry.quizzes) {
            await client.query(
              `INSERT INTO ranking_snapshot_quizzes (
                 snapshot_id, user_id, quiz_attempt_id, work_id, piece_id, title,
                 series, author, taken_at, correct_percent, level, category, word_count, counted_in_score
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              [snapshot.id,entry.userId,quiz.quizAttemptId,quiz.workId,quiz.pieceId,quiz.title,quiz.series,quiz.author,quiz.takenAt,quiz.correctPercent,quiz.level,quiz.category,quiz.wordCount,quiz.countedInScore],
            );
          }
        }
      }
      const generatedAt = new Date();
      await client.query(
        `UPDATE ranking_snapshots SET
           starts_at=$2, ends_at=$3, status='ready', result_status=$4, cohort_size=$5,
           minimum_cohort_size=$6, entries=$7, generated_at=$8, source_max_verified_at=$9
         WHERE id=$1`,
        [snapshot.id,dimensions.startsAt,dimensions.endsAt,resultStatus,computed.entries.length,dimensions.minimumCohortSize,JSON.stringify(publicEntries),generatedAt,computed.sourceMaxVerifiedAt],
      );
      await client.query(
        `INSERT INTO audit_events (
           actor_type, actor_id, action, target_type, target_id, request_id, metadata
         ) VALUES ('service','ranking-aggregator','ranking_snapshot_generated','ranking_snapshot',$1,$2,$3)`,
        [snapshot.id,dimensions.requestId,JSON.stringify({
          ruleVersion:RANKING_RULE_VERSION,
          resultStatus,
          cohortSize:computed.entries.length,
          durationMs:Date.now()-buildStartedAt,
          sourceLagSeconds:computed.sourceMaxVerifiedAt === null
            ? null
            : Math.max(0,Math.round((generatedAt.getTime()-new Date(computed.sourceMaxVerifiedAt).getTime())/1000)),
        })],
      );
      await client.query("COMMIT");
      return {snapshotId:snapshot.id,status:resultStatus,cohortSize:computed.entries.length,minimumCohortSize:dimensions.minimumCohortSize,generatedAt:generatedAt.toISOString(),entries:publicEntries};
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
