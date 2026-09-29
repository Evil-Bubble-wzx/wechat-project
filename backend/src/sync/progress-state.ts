export type MillisecondRange = [number, number];

export type StoredProgressState = {
  pieceId: string;
  contentVersion: number;
  durationMs: number;
  revision: bigint;
  checkpointMs: number;
  listenedRangesMs: MillisecondRange[];
  naturalEndObserved: boolean;
  serverUpdatedAt: string;
};

export type ProgressEvidence = {
  baseRevision: bigint;
  checkpointMs: number | null;
  listenedRangeDeltasMs: MillisecondRange[];
  naturalEndObserved: boolean;
};

export type ProgressFacts = {
  listenedMs: number;
  coverage: number;
  completed: boolean;
};

export type ProgressMergeResult = {
  status: "applied" | "merged_stale" | "unchanged" | "rejected";
  checkpointDecision: "accepted" | "server_retained" | "not_provided" | "not_applicable";
  reason: "future_revision" | "no_material_change" | null;
  state: StoredProgressState | null;
  facts: ProgressFacts | null;
  changed: boolean;
};

export function mergeRangesMs(
  input: MillisecondRange[],
  durationMs: number,
): MillisecondRange[] {
  const sorted = input
    .map(([start, end]) => [
      Math.max(0, Math.min(durationMs, Math.round(start))),
      Math.max(0, Math.min(durationMs, Math.round(end))),
    ] as MillisecondRange)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const output: MillisecondRange[] = [];
  for (const range of sorted) {
    const previous = output.at(-1);
    if (previous && range[0] <= previous[1] + 50) previous[1] = Math.max(previous[1], range[1]);
    else output.push(range);
  }
  return output;
}

export function deriveProgressFacts(
  ranges: MillisecondRange[],
  durationMs: number,
  naturalEndObserved: boolean,
): ProgressFacts {
  const listenedMs = Math.min(
    durationMs,
    ranges.reduce((total, [start, end]) => total + end - start, 0),
  );
  const coverage = durationMs > 0 ? listenedMs / durationMs : 0;
  const tailStart = Math.max(0, durationMs - 3_000);
  const tailCovered = ranges.some(
    ([start, end]) => start <= tailStart + 50 && end >= durationMs - 250,
  );
  return {
    listenedMs,
    coverage,
    completed: naturalEndObserved && coverage >= 0.9 && tailCovered,
  };
}

export function mergeProgressEvidence(
  current: StoredProgressState | null,
  identity: Pick<StoredProgressState, "pieceId" | "contentVersion" | "durationMs">,
  evidence: ProgressEvidence,
  serverUpdatedAt: string,
): ProgressMergeResult {
  const currentRevision = current?.revision ?? 0n;
  if (evidence.baseRevision > currentRevision) {
    return {
      status: "rejected",
      checkpointDecision: "not_applicable",
      reason: "future_revision",
      state: current,
      facts: current
        ? deriveProgressFacts(current.listenedRangesMs, current.durationMs, current.naturalEndObserved)
        : null,
      changed: false,
    };
  }

  const stale = evidence.baseRevision < currentRevision;
  const previousRanges = current?.listenedRangesMs ?? [];
  const listenedRangesMs = mergeRangesMs(
    [...previousRanges, ...evidence.listenedRangeDeltasMs],
    identity.durationMs,
  );
  const naturalEndObserved = Boolean(
    current?.naturalEndObserved || evidence.naturalEndObserved,
  );
  const checkpointMs = stale || evidence.checkpointMs === null
    ? current?.checkpointMs ?? 0
    : Math.max(0, Math.min(identity.durationMs, evidence.checkpointMs));
  const changed = !current
    || checkpointMs !== current.checkpointMs
    || naturalEndObserved !== current.naturalEndObserved
    || JSON.stringify(listenedRangesMs) !== JSON.stringify(previousRanges);
  const state: StoredProgressState = {
    ...identity,
    revision: changed ? currentRevision + 1n : currentRevision,
    checkpointMs,
    listenedRangesMs,
    naturalEndObserved,
    serverUpdatedAt: changed ? serverUpdatedAt : current?.serverUpdatedAt ?? serverUpdatedAt,
  };
  return {
    status: changed ? (stale ? "merged_stale" : "applied") : "unchanged",
    checkpointDecision: evidence.checkpointMs === null
      ? "not_provided"
      : stale
        ? "server_retained"
        : "accepted",
    reason: changed ? null : "no_material_change",
    state,
    facts: deriveProgressFacts(listenedRangesMs, identity.durationMs, naturalEndObserved),
    changed,
  };
}
