import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/api/app.ts";
import type { SavedWordSyncServicePort } from "../src/api/saved-word-sync-routes.ts";
import type { SessionServicePort } from "../src/api/session-routes.ts";
import type { AuthenticatedSession, CurrentUser, SessionTokenResponse } from "../src/auth/session-service.ts";
import {
  savedWordBatchIdFor,
  savedWordOperationIdFor,
  type SavedWordSyncInput,
  type SavedWordSyncResponse,
} from "../src/sync/saved-word-sync-service.ts";

class WordSession implements SessionServicePort {
  private readonly deviceId: string | null;
  constructor(deviceId: string | null = "device-word-a") { this.deviceId = deviceId; }
  async createWechatSession(): Promise<SessionTokenResponse> { throw new Error("unused"); }
  async refreshSession(): Promise<SessionTokenResponse> { throw new Error("unused"); }
  async authenticateAccessToken(token: string): Promise<AuthenticatedSession> {
    assert.equal(token, "word-token");
    return {
      userId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      deviceId: this.deviceId,
    };
  }
  async revokeSession(): Promise<void> { throw new Error("unused"); }
  async getCurrentUser(): Promise<CurrentUser> { throw new Error("unused"); }
}

class FakeWordSync implements SavedWordSyncServicePort {
  last: unknown = null;
  async sync(userId: string, deviceId: string, input: SavedWordSyncInput): Promise<SavedWordSyncResponse> {
    this.last = { userId, deviceId, input };
    return {
      schemaVersion: 1,
      batchId: input.batchId,
      serverTime: "2026-09-29T02:00:00.000Z",
      operations: [],
      changes: [],
      nextCursor: "s03-word-cursor-v1:0:" + "a".repeat(64),
      hasMore: false,
    };
  }
}

function request(): SavedWordSyncInput {
  const body = {
    entryId: "ve-5732b4cca2b4",
    pieceId: "peter-rabbit-01",
    contentVersion: 1,
    vocabKey: "a:determiner:1",
    surface: "a",
    lemma: "a",
    action: "save" as const,
    baseRevision: "0",
    occurredAt: "2026-09-29T01:00:00.000Z",
  };
  const operation = { operationId: savedWordOperationIdFor(body), ...body };
  const payload = { schemaVersion: 1 as const, cursor: null, operations: [operation], limit: 100 };
  return { batchId: savedWordBatchIdFor(payload), ...payload };
}

test("saved word sync authenticates before parsing payloads", async () => {
  const app = createApp({ sessionService: new WordSession(), savedWordSyncService: new FakeWordSync() });
  const response = await app.inject({ method: "POST", url: "/api/v1/me/words/sync", payload: {} });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "UNAUTHENTICATED");
  await app.close();
});

test("saved word sync binds idempotency and verified session device identity", async () => {
  const service = new FakeWordSync();
  const app = createApp({ sessionService: new WordSession(), savedWordSyncService: service });
  const input = request();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/me/words/sync",
    headers: { authorization: "Bearer word-token", "idempotency-key": input.batchId },
    payload: input,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(service.last, {
    userId: "11111111-1111-4111-8111-111111111111",
    deviceId: "device-word-a",
    input,
  });
  await app.close();
});

test("saved word sync rejects unknown fields and sessions without a device", async () => {
  const input = request();
  const headers = { authorization: "Bearer word-token", "idempotency-key": input.batchId };
  const app = createApp({ sessionService: new WordSession(), savedWordSyncService: new FakeWordSync() });
  const malformed = { ...input, operations: [{ ...input.operations[0]!, trusted: true }] };
  const invalid = await app.inject({ method: "POST", url: "/api/v1/me/words/sync", headers, payload: malformed });
  assert.equal(invalid.statusCode, 400);
  await app.close();

  const noDevice = createApp({ sessionService: new WordSession(null), savedWordSyncService: new FakeWordSync() });
  const denied = await noDevice.inject({ method: "POST", url: "/api/v1/me/words/sync", headers, payload: input });
  assert.equal(denied.statusCode, 401);
  await noDevice.close();
});
