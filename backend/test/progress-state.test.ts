import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  deriveProgressFacts,
  mergeProgressEvidence,
  type StoredProgressState,
} from "../src/sync/progress-state.ts";
import { batchIdFor, operationIdFor } from "../src/sync/progress-sync-service.ts";

const require = createRequire(import.meta.url);

const identity = { pieceId: "peter-rabbit-01", contentVersion: 1, durationMs: 20_000 };
const current = (overrides: Partial<StoredProgressState> = {}): StoredProgressState => ({
  ...identity,
  revision: 4n,
  checkpointMs: 8_000,
  listenedRangesMs: [[0, 8_000]],
  naturalEndObserved: false,
  serverUpdatedAt: "2026-09-29T01:00:00.000Z",
  ...overrides,
});

test("same-revision evidence merges ranges and accepts the trusted checkpoint", () => {
  const merged = mergeProgressEvidence(current(), identity, {
    baseRevision: 4n,
    checkpointMs: 12_000,
    listenedRangeDeltasMs: [[8_000, 12_000]],
    naturalEndObserved: false,
  }, "2026-09-29T02:00:00.000Z");

  assert.equal(merged.status, "applied");
  assert.equal(merged.checkpointDecision, "accepted");
  assert.equal(merged.state?.revision, 5n);
  assert.equal(merged.state?.checkpointMs, 12_000);
  assert.deepEqual(merged.state?.listenedRangesMs, [[0, 12_000]]);
});

test("stale evidence contributes coverage but cannot overwrite the newer checkpoint", () => {
  const merged = mergeProgressEvidence(current(), identity, {
    baseRevision: 2n,
    checkpointMs: 3_000,
    listenedRangeDeltasMs: [[12_000, 18_000]],
    naturalEndObserved: false,
  }, "2026-09-29T02:00:00.000Z");

  assert.equal(merged.status, "merged_stale");
  assert.equal(merged.checkpointDecision, "server_retained");
  assert.equal(merged.state?.checkpointMs, 8_000);
  assert.deepEqual(merged.state?.listenedRangesMs, [[0, 8_000], [12_000, 18_000]]);
});

test("future revisions are rejected without mutation", () => {
  const before = current();
  const merged = mergeProgressEvidence(before, identity, {
    baseRevision: 8n,
    checkpointMs: 18_000,
    listenedRangeDeltasMs: [[8_000, 18_000]],
    naturalEndObserved: true,
  }, "2026-09-29T02:00:00.000Z");

  assert.equal(merged.status, "rejected");
  assert.equal(merged.reason, "future_revision");
  assert.equal(merged.state, before);
});

test("completion requires coverage, the final three seconds and natural end evidence", () => {
  assert.equal(deriveProgressFacts([[0, 20_000]], 20_000, false).completed, false);
  assert.equal(deriveProgressFacts([[0, 17_100]], 20_000, true).completed, false);
  assert.equal(deriveProgressFacts([[0, 20_000]], 20_000, true).completed, true);
});

test("client and server freeze the same canonical S-02 operation and batch IDs", () => {
  const client = require("../../miniprogram/modules/sync/progress-sync.js") as {
    operationIdFor(value: unknown): string;
    batchIdFor(value: unknown): string;
  };
  const operation = {
    pieceId: "peter-rabbit-01",
    contentVersion: 1,
    durationMs: 20_000,
    baseRevision: "7",
    listenedRangeDeltasMs: [[12_000, 16_000]] as Array<[number, number]>,
    checkpointMs: 16_000,
    naturalEndObserved: false,
    occurredAt: "2026-09-29T01:00:00.000Z",
  };
  const operationId = operationIdFor(operation);
  assert.equal(client.operationIdFor(operation), operationId);
  const payload = {
    schemaVersion: 1 as const,
    cursor: null,
    operations: [{ operationId, ...operation }],
    limit: 100,
  };
  assert.equal(client.batchIdFor(payload), batchIdFor(payload));
});
