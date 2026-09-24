import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRankingFeatures,
  RANKING_RULE_VERSION,
  RANKING_WEIGHTS,
  scoreRankingCohort,
  type RankingParticipantFacts,
} from "../src/ranking/score.ts";

const attempt = (
  workId: string,
  submittedAt: string,
  accuracyPercent: number,
  wordCount: number,
  bookLevel = 3,
  category: "fiction" | "nonfiction" = "fiction",
) => ({ workId, submittedAt, accuracyPercent, wordCount, bookLevel, category });

test("ranking score v1 has explicit weights that total one", () => {
  assert.equal(RANKING_RULE_VERSION, "quiz-score-v1");
  assert.equal(Object.values(RANKING_WEIGHTS).reduce((sum, value) => sum + value, 0), 1);
});

test("the first verified Quiz per work is the only attempt that affects ranking features", () => {
  const features = buildRankingFeatures({
    participantId: "reader-a",
    profileLevel: 3,
    attempts: [
      attempt("book-1", "2026-09-20T08:00:00Z", 60, 1000),
      attempt("book-1", "2026-09-21T08:00:00Z", 100, 1000),
      attempt("book-2", "2026-09-22T08:00:00Z", 80, 1500, 4, "nonfiction"),
    ],
  });
  assert.equal(features.completion, 2);
  assert.ok(features.accuracy < 80, "the retry must not replace the first attempt");
  assert.equal(features.challenge, 0.5);
  assert.equal(features.breadth, 1);
});

test("cohort score rewards balanced verified performance and stays within 0-1000", () => {
  const participants: RankingParticipantFacts[] = [
    {
      participantId: "reader-a",
      profileLevel: 3,
      attempts: Array.from({ length: 6 }, (_, index) =>
        attempt(`a-${index}`, `2026-09-${String(10 + index).padStart(2, "0")}T08:00:00Z`, 75 + index * 3, 1800, 3.5, index % 2 ? "fiction" : "nonfiction")),
    },
    {
      participantId: "reader-b",
      profileLevel: 3,
      attempts: Array.from({ length: 3 }, (_, index) =>
        attempt(`b-${index}`, `2026-09-${String(10 + index).padStart(2, "0")}T08:00:00Z`, 65, 700, 2.5, "fiction")),
    },
  ];
  const ranked = scoreRankingCohort(participants);
  assert.equal(ranked[0]?.participantId, "reader-a");
  assert.equal(ranked[0]?.rank, 1);
  assert.ok(ranked.every((item) => item.score >= 0 && item.score <= 1000));
  assert.equal(ranked[0]?.breakdown.length, 6);
});

test("missing level, growth and category facts are neutral rather than fabricated", () => {
  const ranked = scoreRankingCohort([
    { participantId:"reader-a", attempts:[attempt("a", "2026-09-10T08:00:00Z", 80, 1000)] },
    { participantId:"reader-b", attempts:[attempt("b", "2026-09-10T08:00:00Z", 80, 1000)] },
  ]);
  assert.equal(ranked[0]?.features.challenge,null);
  assert.equal(ranked[0]?.features.growth,null);
  assert.equal(ranked[0]?.score,500);
  assert.equal(ranked[1]?.score,500);
  assert.equal(ranked[0]?.rank,1);
  assert.equal(ranked[1]?.rank,1);
});

test("participants without a completed Quiz book are not ranked", () => {
  const ranked = scoreRankingCohort([
    { participantId:"reader-empty", attempts:[] },
    { participantId:"reader-active", attempts:[attempt("book-1", "2026-09-10T08:00:00Z", 80, 1000)] },
  ]);
  assert.deepEqual(ranked.map((item) => item.participantId),["reader-active"]);
  assert.equal(ranked[0]?.score,500);
});
