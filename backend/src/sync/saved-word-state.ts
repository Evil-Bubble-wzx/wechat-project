export type SavedWordIdentity = {
  entryId: string;
  pieceId: string;
  contentVersion: number;
  vocabKey: string;
  surface: string;
  lemma: string;
};

export type StoredSavedWordState = SavedWordIdentity & {
  revision: bigint;
  deleted: boolean;
  serverUpdatedAt: string;
};

export type SavedWordMutation = SavedWordIdentity & {
  baseRevision: bigint;
  action: "save" | "delete";
};

export type SavedWordMergeResult = {
  status: "applied" | "merged_stale" | "unchanged" | "rejected";
  decision: "saved" | "deleted" | "server_retained" | "not_applicable";
  reason:
    | "future_revision"
    | "entry_identity_mismatch"
    | "stale_save_blocked_by_delete"
    | "no_material_change"
    | "delete_wins"
    | null;
  state: StoredSavedWordState | null;
  changed: boolean;
};

function sameIdentity(current: StoredSavedWordState, mutation: SavedWordMutation): boolean {
  return current.entryId === mutation.entryId
    && current.pieceId === mutation.pieceId
    && current.vocabKey === mutation.vocabKey
    && current.lemma === mutation.lemma;
}

export function mergeSavedWordMutation(
  current: StoredSavedWordState | null,
  mutation: SavedWordMutation,
  serverUpdatedAt: string,
): SavedWordMergeResult {
  const currentRevision = current?.revision ?? 0n;
  if (mutation.baseRevision > currentRevision) {
    return {
      status: "rejected",
      decision: "not_applicable",
      reason: "future_revision",
      state: current,
      changed: false,
    };
  }
  if (current && !sameIdentity(current, mutation)) {
    return {
      status: "rejected",
      decision: "not_applicable",
      reason: "entry_identity_mismatch",
      state: current,
      changed: false,
    };
  }

  const stale = mutation.baseRevision < currentRevision;
  const wantsDeleted = mutation.action === "delete";
  if (stale && !wantsDeleted && current?.deleted) {
    return {
      status: "unchanged",
      decision: "server_retained",
      reason: "stale_save_blocked_by_delete",
      state: current,
      changed: false,
    };
  }

  const deleted = wantsDeleted;
  const changed = !current
    || current.deleted !== deleted
    || current.contentVersion !== mutation.contentVersion
    || current.surface !== mutation.surface;
  if (!changed) {
    return {
      status: "unchanged",
      decision: current?.deleted ? "deleted" : "saved",
      reason: "no_material_change",
      state: current,
      changed: false,
    };
  }

  const state: StoredSavedWordState = {
    entryId: mutation.entryId,
    pieceId: mutation.pieceId,
    contentVersion: mutation.contentVersion,
    vocabKey: mutation.vocabKey,
    surface: mutation.surface,
    lemma: mutation.lemma,
    revision: currentRevision + 1n,
    deleted,
    serverUpdatedAt,
  };
  return {
    status: stale ? "merged_stale" : "applied",
    decision: deleted ? "deleted" : "saved",
    reason: stale && deleted ? "delete_wins" : null,
    state,
    changed: true,
  };
}
