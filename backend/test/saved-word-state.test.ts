import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  mergeSavedWordMutation,
  type SavedWordMutation,
  type StoredSavedWordState,
} from "../src/sync/saved-word-state.ts";
import {
  savedWordBatchIdFor,
  savedWordOperationIdFor,
} from "../src/sync/saved-word-sync-service.ts";

const require = createRequire(import.meta.url);
const identity = {
  entryId: "ve-5732b4cca2b4",
  pieceId: "peter-rabbit-01",
  contentVersion: 1,
  vocabKey: "a:determiner:1",
  surface: "a",
  lemma: "a",
};
const current = (overrides: Partial<StoredSavedWordState> = {}): StoredSavedWordState => ({
  ...identity,
  revision: 4n,
  deleted: false,
  serverUpdatedAt: "2026-09-29T01:00:00.000Z",
  ...overrides,
});
const mutation = (overrides: Partial<SavedWordMutation> = {}): SavedWordMutation => ({
  ...identity,
  action: "save",
  baseRevision: 4n,
  ...overrides,
});

test("saved word delete is a revisioned tombstone", () => {
  const result = mergeSavedWordMutation(current(), mutation({ action: "delete" }), "2026-09-29T02:00:00.000Z");
  assert.equal(result.status, "applied");
  assert.equal(result.decision, "deleted");
  assert.equal(result.state?.revision, 5n);
  assert.equal(result.state?.deleted, true);
});

test("stale delete wins but stale save cannot resurrect a tombstone", () => {
  const deleted = current({ revision: 5n, deleted: true });
  const staleSave = mergeSavedWordMutation(deleted, mutation({ baseRevision: 4n }), "2026-09-29T02:00:00.000Z");
  assert.equal(staleSave.status, "unchanged");
  assert.equal(staleSave.reason, "stale_save_blocked_by_delete");
  assert.equal(staleSave.state?.deleted, true);

  const staleDelete = mergeSavedWordMutation(current(), mutation({ action: "delete", baseRevision: 2n }), "2026-09-29T02:00:00.000Z");
  assert.equal(staleDelete.status, "merged_stale");
  assert.equal(staleDelete.reason, "delete_wins");
  assert.equal(staleDelete.state?.deleted, true);
});

test("an explicit save based on the current tombstone can restore a word", () => {
  const result = mergeSavedWordMutation(current({ revision: 5n, deleted: true }), mutation({ baseRevision: 5n }), "2026-09-29T02:00:00.000Z");
  assert.equal(result.status, "applied");
  assert.equal(result.state?.revision, 6n);
  assert.equal(result.state?.deleted, false);
});

test("a current-revision save may carry a stable entry into a new content version", () => {
  const result = mergeSavedWordMutation(current(), mutation({ contentVersion: 2, surface: "A" }), "2026-09-29T02:00:00.000Z");
  assert.equal(result.status, "applied");
  assert.equal(result.state?.contentVersion, 2);
  assert.equal(result.state?.surface, "A");
  assert.equal(result.state?.revision, 5n);
});

test("future revisions and stable entry identity reuse are rejected", () => {
  assert.equal(mergeSavedWordMutation(current(), mutation({ baseRevision: 8n }), "2026-09-29T02:00:00.000Z").reason, "future_revision");
  assert.equal(mergeSavedWordMutation(current(), mutation({ vocabKey: "other:noun:1" }), "2026-09-29T02:00:00.000Z").reason, "entry_identity_mismatch");
});

test("client and server freeze the same canonical S-03 IDs", () => {
  const client = require("../../miniprogram/modules/sync/saved-word-sync.js") as {
    operationIdFor(value: unknown): string;
    batchIdFor(value: unknown): string;
  };
  const body = {
    ...identity,
    action: "save" as const,
    baseRevision: "3",
    occurredAt: "2026-09-29T01:00:00.000Z",
  };
  const operationId = savedWordOperationIdFor(body);
  assert.equal(client.operationIdFor(body), operationId);
  const payload = { schemaVersion: 1 as const, cursor: null, operations: [{ operationId, ...body }], limit: 100 };
  assert.equal(client.batchIdFor(payload), savedWordBatchIdFor(payload));
});
