import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuthenticatedSession,
  CurrentUser,
  SessionTokenResponse,
} from "../src/auth/session-service.ts";
import { createApp } from "../src/api/app.ts";
import type { SessionServicePort } from "../src/api/session-routes.ts";

const tokenResponse: SessionTokenResponse = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  accessToken: "a".repeat(32),
  accessTokenExpiresAt: "2026-09-24T04:00:00.000Z",
  refreshToken: "r".repeat(32),
  refreshTokenExpiresAt: "2026-10-24T03:00:00.000Z",
};

class FakeSessionService implements SessionServicePort {
  public revoked = false;

  async createWechatSession(): Promise<SessionTokenResponse> {
    return tokenResponse;
  }

  async refreshSession(): Promise<SessionTokenResponse> {
    return tokenResponse;
  }

  async authenticateAccessToken(token: string): Promise<AuthenticatedSession> {
    assert.equal(token, "valid-access-token");
    return { userId: tokenResponse.userId, sessionId: tokenResponse.sessionId };
  }

  async revokeSession(input: {
    accessToken: string;
    idempotencyKey: string;
  }): Promise<void> {
    assert.equal(input.accessToken, "valid-access-token");
    assert.equal(input.idempotencyKey, "logout-key-001");
    this.revoked = true;
  }

  async getCurrentUser(): Promise<CurrentUser> {
    return {
      userId: tokenResponse.userId,
      status: "active",
      profile: { campusId: "a", grade: "3", readingLevel: "2" },
    };
  }
}

test("POST /api/v1/session/wechat returns contract-shaped tokens", async () => {
  const app = createApp({ sessionService: new FakeSessionService() });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/session/wechat",
    headers: { "idempotency-key": "login-key-001" },
    payload: { code: "test:user-001", deviceId: "device-001" },
  });

  assert.equal(response.statusCode, 201);
  assert.match(response.json().requestId, /^[0-9a-f-]{36}$/);
  assert.equal(response.json().userId, tokenResponse.userId);
  assert.equal(response.json().refreshToken, tokenResponse.refreshToken);
  await app.close();
});

test("session routes reject missing idempotency and bearer headers with stable errors", async () => {
  const app = createApp({ sessionService: new FakeSessionService() });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/session/wechat",
    payload: { code: "test:user-001" },
  });
  const me = await app.inject({ method: "GET", url: "/api/v1/me" });

  assert.equal(login.statusCode, 400);
  assert.equal(login.json().error.code, "INVALID_REQUEST");
  assert.equal(me.statusCode, 401);
  assert.equal(me.json().error.code, "UNAUTHENTICATED");
  await app.close();
});

test("GET /me and DELETE current session use the authenticated session", async () => {
  const service = new FakeSessionService();
  const app = createApp({ sessionService: service });
  const authorization = "Bearer valid-access-token";
  const me = await app.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization },
  });
  const logout = await app.inject({
    method: "DELETE",
    url: "/api/v1/session/current",
    headers: { authorization, "idempotency-key": "logout-key-001" },
  });

  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json().profile, {
    campusId: "a",
    grade: "3",
    readingLevel: "2",
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(logout.json().status, "revoked");
  assert.equal(service.revoked, true);
  await app.close();
});
