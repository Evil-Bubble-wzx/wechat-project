export const RANKING_RULE_VERSION = "quiz-score-v1";

export const RANKING_WEIGHTS = {
  completion: 0.3,
  words: 0.15,
  accuracy: 0.25,
  challenge: 0.15,
  growth: 0.1,
  breadth: 0.05,
} as const;

export type RankingAttemptFact = {
  workId: string;
  submittedAt: string;
  accuracyPercent: number;
  wordCount: number;
  bookLevel?: number | null;
  category?: "fiction" | "nonfiction" | null;
};

export type RankingParticipantFacts = {
  participantId: string;
  profileLevel?: number | null;
  attempts: RankingAttemptFact[];
};

export type RankingFeatureKey = keyof typeof RANKING_WEIGHTS;

export type RankingFeatureSet = {
  completion: number;
  words: number;
  accuracy: number;
  challenge: number | null;
  growth: number | null;
  breadth: number | null;
};

export type RankingScoreBreakdown = {
  key: RankingFeatureKey;
  label: string;
  weight: number;
  percentile: number;
  points: number;
  maxPoints: number;
};

export type RankingScoreResult = {
  participantId: string;
  rank: number;
  score: number;
  completedBooks: number;
  totalWords: number;
  adjustedAccuracy: number;
  features: RankingFeatureSet;
  breakdown: RankingScoreBreakdown[];
};

const labels: Record<RankingFeatureKey, string> = {
  completion: "Quiz Completion",
  words: "Reading Volume",
  accuracy: "Accuracy",
  challenge: "Challenge",
  growth: "Growth",
  breadth: "Breadth",
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function selectRankingAttempts(attempts: RankingAttemptFact[]): RankingAttemptFact[] {
  const ordered = attempts
    .filter((attempt) => attempt.workId.trim())
    .filter((attempt) => Number.isFinite(attempt.accuracyPercent))
    .sort((left, right) => timestamp(left.submittedAt) - timestamp(right.submittedAt));
  const seen = new Set<string>();
  return ordered.filter((attempt) => {
    if (seen.has(attempt.workId)) return false;
    seen.add(attempt.workId);
    return true;
  });
}

export function buildRankingFeatures(participant: RankingParticipantFacts): RankingFeatureSet {
  const attempts = selectRankingAttempts(participant.attempts);
  const accuracies = attempts.map((attempt) => clamp(attempt.accuracyPercent, 0, 100));
  const accuracy = (accuracies.reduce((sum, value) => sum + value, 0) + 3 * 70) /
    (accuracies.length + 3);
  const levelDeltas = attempts
    .filter((attempt) => Number.isFinite(attempt.bookLevel) && Number.isFinite(participant.profileLevel))
    .map((attempt) => clamp(Number(attempt.bookLevel) - Number(participant.profileLevel), -1.5, 1.5));
  const categorized = attempts.filter((attempt) => attempt.category === "fiction" || attempt.category === "nonfiction");
  const fictionShare = categorized.length
    ? categorized.filter((attempt) => attempt.category === "fiction").length / categorized.length
    : null;
  const half = Math.floor(accuracies.length / 2);
  const growth = accuracies.length >= 6
    ? average(accuracies.slice(accuracies.length - half)) - average(accuracies.slice(0, half))
    : null;

  return {
    completion: attempts.length,
    words: Math.log1p(attempts.reduce((sum, attempt) => sum + Math.max(0, Math.round(attempt.wordCount || 0)), 0)),
    accuracy,
    challenge: levelDeltas.length ? average(levelDeltas) : null,
    growth,
    breadth: fictionShare === null || categorized.length < 2 ? null : 1 - Math.abs(fictionShare - 0.5) * 2,
  };
}

function midrankPercentiles(values: Array<number | null>): number[] {
  const available = values
    .map((value, index) => ({ value, index }))
    .filter((item): item is { value: number; index: number } => item.value !== null && Number.isFinite(item.value))
    .sort((left, right) => left.value - right.value);
  const result = values.map(() => 0.5);
  if (available.length < 2) return result;

  for (let start = 0; start < available.length;) {
    let end = start;
    while (end + 1 < available.length && available[end + 1]?.value === available[start]?.value) end += 1;
    const percentile = (start + end) / (2 * (available.length - 1));
    for (let cursor = start; cursor <= end; cursor += 1) result[available[cursor]!.index] = percentile;
    start = end + 1;
  }
  return result;
}

export function scoreRankingCohort(participants: RankingParticipantFacts[]): RankingScoreResult[] {
  const unique = new Set<string>();
  for (const participant of participants) {
    if (!participant.participantId.trim() || unique.has(participant.participantId)) {
      throw new Error("Ranking participant IDs must be non-empty and unique");
    }
    unique.add(participant.participantId);
  }

  const eligible = participants.filter((participant) => buildRankingFeatures(participant).completion > 0);
  const features = eligible.map(buildRankingFeatures);
  const keys = Object.keys(RANKING_WEIGHTS) as RankingFeatureKey[];
  const percentiles = Object.fromEntries(
    keys.map((key) => [key, midrankPercentiles(features.map((feature) => feature[key]))]),
  ) as Record<RankingFeatureKey, number[]>;

  const scored = eligible.map((participant, index) => {
    const score = clamp(Math.round(keys.reduce(
      (sum, key) => sum + 1000 * RANKING_WEIGHTS[key] * percentiles[key][index]!,
      0,
    )), 0, 1000);
    const breakdown = keys.map((key) => ({
      key,
      label: labels[key],
      weight: RANKING_WEIGHTS[key],
      percentile: percentiles[key][index]!,
      points: Math.round(1000 * RANKING_WEIGHTS[key] * percentiles[key][index]!),
      maxPoints: Math.round(1000 * RANKING_WEIGHTS[key]),
    }));
    const roundingDelta = score - breakdown.reduce((sum, item) => sum + item.points, 0);
    breakdown[breakdown.length - 1]!.points += roundingDelta;
    const participantAttempts = selectRankingAttempts(participant.attempts);
    return {
      participantId: participant.participantId,
      rank: 0,
      score,
      completedBooks: features[index]!.completion,
      totalWords: participantAttempts.reduce((sum, attempt) => sum + Math.max(0, Math.round(attempt.wordCount || 0)), 0),
      adjustedAccuracy: Number(features[index]!.accuracy.toFixed(2)),
      features: features[index]!,
      breakdown,
    };
  });

  scored.sort((left, right) =>
    right.score - left.score ||
    right.completedBooks - left.completedBooks ||
    right.adjustedAccuracy - left.adjustedAccuracy ||
    left.participantId.localeCompare(right.participantId));
  scored.forEach((item, index) => {
    item.rank = index > 0 && item.score === scored[index - 1]!.score ? scored[index - 1]!.rank : index + 1;
  });
  return scored;
}
