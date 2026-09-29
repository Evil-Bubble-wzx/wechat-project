import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/api/app.ts";
import type { ProgressSyncServicePort } from "../src/api/progress-sync-routes.ts";
import type { SessionServicePort } from "../src/api/session-routes.ts";
import type { AuthenticatedSession, CurrentUser, SessionTokenResponse } from "../src/auth/session-service.ts";
import {
  batchIdFor,
  operationIdFor,
  type ProgressSyncInput,
  type ProgressSyncResponse,
} from "../src/sync/progress-sync-service.ts";

class SyncSession implements SessionServicePort {
  private readonly deviceId: string | null;
  constructor(deviceId: string | null = "device-001") { this.deviceId = deviceId; }
  async createWechatSession(): Promise<SessionTokenResponse> { throw new Error("unused"); }
  async refreshSession(): Promise<SessionTokenResponse> { throw new Error("unused"); }
  async authenticateAccessToken(token: string): Promise<AuthenticatedSession> {
    assert.equal(token, "sync-token");
    return {
      userId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      deviceId: this.deviceId,
    };
  }
  async revokeSession(): Promise<void> { throw new Error("unused"); }
  async getCurrentUser(): Promise<CurrentUser> { throw new Error("unused"); }
}

class FakeSync implements ProgressSyncServicePort {
  last: unknown = null;
  async sync(userId: string, deviceId: string, input: ProgressSyncInput): Promise<ProgressSyncResponse> {
    this.last = { userId, deviceId, input };
    return {
      schemaVersion: 1,
      batchId: input.batchId,
      serverTime: "2026-09-29T02:00:00.000Z",
      operations: [],
      changes: [],
      nextCursor: "s02-cursor-v1:0:" + "a".repeat(64),
      hasMore: false,
    };
  }
}

function request(): ProgressSyncInput {
  const operationBody = {
    pieceId: "peter-rabbit-01",
    contentVersion: 1,
    durationMs: 20_000,
    baseRevision: "0",
    listenedRangeDeltasMs: [[0, 6_000]] as Array<[number, number]>,
    checkpointMs: 6_000,
    naturalEndObserved: false,
    occurredAt: "2026-09-29T01:00:00.000Z",
  };
  const operation = { operationId: operationIdFor(operationBody), ...operationBody };
  const body = { schemaVersion: 1 as const, cursor: null, operations: [operation], limit: 50 };
  return { batchId: batchIdFor(body), ...body };
}

test("progress sync authenticates before parsing payloads", async () => {
  const app = createApp({ sessionService: new SyncSession(), progressSyncService: new FakeSync() });
  const response = await app.inject({ method: "POST", url: "/api/v1/me/progress/sync", payload: {} });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");
  await app.close();
});

test("progress sync binds idempotency and verified session device identity", async () => {
  const service = new FakeSync();
  const app = createApp({ sessionService: new SyncSession(), progressSyncService: service });
  const input = request();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/me/progress/sync",
    headers: { authorization: "Bearer sync-token", "idempotency-key": input.batchId },
    payload: input,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().batchId, input.batchId);
  assert.deepEqual(service.last, {
    userId: "11111111-1111-4111-8111-111111111111",
    deviceId: "device-001",
    input,
  });
  await app.close();
});

test("progress sync rejects unnormalized evidence and sessions without a device", async () => {
  const input = request();
  const headers = { authorization: "Bearer sync-token", "idempotency-key": input.batchId };
  const app = createApp({ sessionService: new SyncSession(), progressSyncService: new FakeSync() });
  const malformed = {
    ...input,
    operations: [{ ...input.operations[0]!, listenedRangeDeltasMs: [[8_000, 9_000], [1_000, 2_000]] }],
  };
  const invalid = await app.inject({ method: "POST", url: "/api/v1/me/progress/sync", headers, payload: malformed });
  assert.equal(invalid.statusCode, 400);
  await app.close();

  const noDevice = createApp({ sessionService: new SyncSession(null), progressSyncService: new FakeSync() });
  const denied = await noDevice.inject({ method: "POST", url: "/api/v1/me/progress/sync", headers, payload: input });
  assert.equal(denied.statusCode, 401);
  await noDevice.close();
});
