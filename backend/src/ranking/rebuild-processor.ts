import type { Pool } from "pg";

import { RankingAggregationService, type RankingDimensions } from "./aggregation-service.ts";
import { isoWeek, monthWindow, shanghaiDate, weekWindow, yearWindow } from "./query-service.ts";

const DAY_MS = 86_400_000;
const MAX_ATTEMPTS = 5;

type RebuildEvent = {
  id: string;
  quizAttemptId: string;
  userId: string;
  submittedAt: Date;
};

type Profile = {
  campus_id: string;
  grade: string | null;
  reading_level: string | null;
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

function periodWindows(now: Date, submittedAt: Date, eventId: string): Array<{
  periodType: RankingDimensions["periodType"];
  periodKey: string;
  startsAt: Date;
  endsAt: Date;
}> {
  const week = isoWeek(submittedAt);
  const weekKey = `${week.year}-W${pad2(week.week)}`;
  const local = shanghaiDate(submittedAt);
  const monthKey = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}`;
  const yearKey = String(local.getUTCFullYear());
  const rollingEnd = now > submittedAt ? now : new Date(submittedAt.getTime() + 1);
  return [
    {
      periodType: "rolling7",
      periodKey: `${rollingEnd.toISOString()}/${eventId}`,
      startsAt: new Date(rollingEnd.getTime() - 7 * DAY_MS),
      endsAt: rollingEnd,
    },
    { periodType: "week", periodKey: weekKey, ...weekWindow(weekKey) },
    { periodType: "month", periodKey: monthKey, ...monthWindow(monthKey) },
    { periodType: "year", periodKey: yearKey, ...yearWindow(yearKey) },
  ];
}

export class RankingRebuildProcessor {
  private readonly pool: Pool;
  private readonly aggregation: RankingAggregationService;
  private readonly now: () => Date;

  constructor(
    pool: Pool,
    aggregation: RankingAggregationService,
    now: () => Date = () => new Date(),
  ) {
    this.pool = pool;
    this.aggregation = aggregation;
    this.now = now;
  }

  private async claim(): Promise<RebuildEvent | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string;
        quiz_attempt_id: string;
        user_id: string;
        submitted_at: Date;
      }>(
        `SELECT event.id, event.quiz_attempt_id, attempt.user_id, attempt.submitted_at
         FROM ranking_rebuild_events event
         JOIN quiz_attempts attempt ON attempt.id = event.quiz_attempt_id
         WHERE event.available_at <= now()
           AND (
             event.status = 'pending'
             OR (event.status = 'failed' AND event.attempts < $1)
             OR (event.status = 'processing' AND event.locked_at < now() - interval '5 minutes')
           )
         ORDER BY event.created_at
         LIMIT 1
         FOR UPDATE OF event SKIP LOCKED`,
        [MAX_ATTEMPTS],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE ranking_rebuild_events
         SET status='processing', attempts=attempts+1, locked_at=now(), updated_at=now(), last_error=NULL
         WHERE id=$1`,
        [row.id],
      );
      await client.query("COMMIT");
      return {
        id: row.id,
        quizAttemptId: row.quiz_attempt_id,
        userId: row.user_id,
        submittedAt: row.submitted_at,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async profileAt(userId: string, at: Date): Promise<Profile | null> {
    const result = await this.pool.query<Profile>(
      `SELECT campus_id, grade, reading_level
       FROM user_profile_versions
       WHERE user_id=$1 AND effective_from <= $2
         AND (effective_until IS NULL OR effective_until > $2)
         AND profile_source IN ('admin','school_sync')
         AND source_verified_at IS NOT NULL
         AND campus_id IS NOT NULL
       ORDER BY effective_from DESC LIMIT 1`,
      [userId, at],
    );
    return result.rows[0] ?? null;
  }

  private dimensions(profile: Profile, event: RebuildEvent, window: ReturnType<typeof periodWindows>[number]): RankingDimensions[] {
    const combinations = [
      { grade: null, readingLevel: null },
      { grade: profile.grade, readingLevel: null },
      { grade: null, readingLevel: profile.reading_level },
      { grade: profile.grade, readingLevel: profile.reading_level },
    ];
    const seen = new Set<string>();
    return combinations.flatMap(({ grade, readingLevel }) => {
      const key = `${grade ?? "all"}:${readingLevel ?? "all"}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        periodType: window.periodType,
        periodKey: window.periodKey,
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
        campusId: profile.campus_id,
        grade,
        readingLevel,
        minimumCohortSize: 10,
        requestId: event.id,
      }];
    });
  }

  private async complete(eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ranking_rebuild_events
       SET status='completed', completed_at=now(), locked_at=NULL, updated_at=now()
       WHERE id=$1`,
      [eventId],
    );
  }

  private async fail(eventId: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await this.pool.query(
      `UPDATE ranking_rebuild_events
       SET status='failed', available_at=now() + make_interval(secs => LEAST(300, 5 * attempts)),
           locked_at=NULL, last_error=$2, updated_at=now()
       WHERE id=$1`,
      [eventId, message],
    );
  }

  async processOne(): Promise<boolean> {
    const event = await this.claim();
    if (!event) return false;
    try {
      for (const window of periodWindows(this.now(), event.submittedAt, event.id)) {
        const profile = await this.profileAt(event.userId, window.startsAt);
        if (!profile) continue;
        for (const dimensions of this.dimensions(profile, event, window)) {
          await this.aggregation.build(dimensions);
        }
      }
      await this.complete(event.id);
      return true;
    } catch (error) {
      await this.fail(event.id, error);
      throw error;
    }
  }

  async processAvailable(limit = 10): Promise<number> {
    let processed = 0;
    while (processed < limit && await this.processOne()) processed += 1;
    return processed;
  }
}
