import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { SignJWT } from "jose";
import pg from "pg";

import { ApiError } from "../src/api/errors.ts";
import { SessionService } from "../src/auth/session-service.ts";
import { StubWechatIdentityProvider } from "../src/auth/wechat-provider.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { decodeKey } from "../src/security/crypto.ts";

const { Pool } = pg;
const schema = `session_test_${randomBytes(8).toString("hex")}`;
if (!/^session_test_[a-f0-9]{16}$/.test(schema)) {
  throw new Error("Generated session test schema is invalid");
}

const baseConfig = loadConfig();
const config = loadConfig({
  APP_ENV: "test",
  DATABASE_URL: baseConfig.databaseUrl,
  WECHAT_PROVIDER: "stub",
});
const adminPool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 5,
  options: `-c search_path=${schema},public`,
});

async function expectApiError(
  action: Promise<unknown>,
  expectedCode: string,
): Promise<ApiError> {
  try {
    await action;
  } catch (error) {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, expectedCode);
    return error;
  }
  assert.fail(`Expected ApiError ${expectedCode}`);
}

async function main(): Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  try {
    await migrateUp(pool, { schema });
    const service = new SessionService(pool, new StubWechatIdentityProvider(), config);

    const loginInput = {
      code: "test:session-alice",
      deviceId: "device-alice-001",
      idempotencyKey: "login-alice-001",
    };
    const login = await service.createWechatSession(loginInput);
    const repeatedLogin = await service.createWechatSession(loginInput);
    assert.deepEqual(repeatedLogin, login);
    await expectApiError(
      service.createWechatSession({
        ...loginInput,
        code: "test:session-other",
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
    await expectApiError(
      service.createWechatSession({
        ...loginInput,
        idempotencyKey: "login-alice-002",
      }),
      "AUTH_CODE_INVALID",
    );

    const authenticated = await service.authenticateAccessToken(login.accessToken);
    assert.equal(authenticated.userId, login.userId);
    const rotatedConfig = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: baseConfig.databaseUrl,
      WECHAT_PROVIDER: "stub",
      TOKEN_SIGNING_KEY_BASE64: randomBytes(32).toString("base64"),
      PREVIOUS_TOKEN_SIGNING_KEY_BASE64: config.auth.tokenSigningKeyBase64,
    });
    const rotatedService = new SessionService(pool, new StubWechatIdentityProvider(), rotatedConfig);
    assert.equal((await rotatedService.authenticateAccessToken(login.accessToken)).userId, login.userId);
    const me = await service.getCurrentUser(authenticated);
    assert.deepEqual(me.profile, { campusId: null, grade: null, readingLevel: null });
    const expiredAccessToken = await new SignJWT({ sid: login.sessionId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(login.userId)
      .setIssuer("tingyue-api")
      .setAudience("tingyue-test")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(decodeKey(config.auth.tokenSigningKeyBase64));
    await expectApiError(
      service.authenticateAccessToken(expiredAccessToken),
      "ACCESS_TOKEN_EXPIRED",
    );
    await expectApiError(
      service.authenticateAccessToken(`${login.accessToken.slice(0, -1)}x`),
      "UNAUTHENTICATED",
    );
    await expectApiError(
      service.refreshSession({
        refreshToken: "invalid-refresh-token-value-that-is-long-enough",
        idempotencyKey: "refresh-invalid-001",
        requestId: "request-refresh-invalid-001",
      }),
      "UNAUTHENTICATED",
    );

    const identityStorage = await pool.query<{
      ciphertext_text: string;
      raw_refresh_count: string;
    }>(
      `SELECT
         encode((SELECT openid_ciphertext FROM wechat_identities LIMIT 1), 'escape') AS ciphertext_text,
         (SELECT count(*)::text FROM user_sessions WHERE refresh_token_hash = $1) AS raw_refresh_count`,
      [login.refreshToken],
    );
    assert.equal(identityStorage.rows[0]?.ciphertext_text.includes("stub-openid"), false);
    assert.equal(identityStorage.rows[0]?.raw_refresh_count, "0");

    const refreshInput = {
      refreshToken: login.refreshToken,
      idempotencyKey: "refresh-alice-001",
      requestId: "request-refresh-alice-001",
    };
    const refreshed = await service.refreshSession(refreshInput);
    assert.notEqual(refreshed.refreshToken, login.refreshToken);
    assert.deepEqual(await service.refreshSession(refreshInput), refreshed);
    await expectApiError(
      service.refreshSession({
        ...refreshInput,
        idempotencyKey: "refresh-alice-reuse",
        requestId: "request-refresh-alice-reuse",
      }),
      "REFRESH_TOKEN_REUSED",
    );
    await expectApiError(
      service.authenticateAccessToken(refreshed.accessToken),
      "UNAUTHENTICATED",
    );

    const logoutLogin = await service.createWechatSession({
      code: "test:session-logout",
      deviceId: "device-logout-001",
      idempotencyKey: "login-logout-001",
    });
    const logoutInput = {
      accessToken: logoutLogin.accessToken,
      idempotencyKey: "logout-session-001",
    };
    await service.revokeSession(logoutInput);
    await service.revokeSession(logoutInput);
    await expectApiError(
      service.authenticateAccessToken(logoutLogin.accessToken),
      "UNAUTHENTICATED",
    );

    const disabledLogin = await service.createWechatSession({
      code: "test:session-disabled",
      deviceId: "device-disabled-001",
      idempotencyKey: "login-disabled-001",
    });
    await pool.query("UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1", [
      disabledLogin.userId,
    ]);
    await expectApiError(
      service.authenticateAccessToken(disabledLogin.accessToken),
      "FORBIDDEN",
    );

    const securityEvents = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_events WHERE action = 'refresh_token_reuse'",
    );
    assert.equal(securityEvents.rows[0]?.count, "1");
    process.stdout.write(
      `session.smoke.passed schema=${schema} login=idempotent refresh=rotated reuse=revoked logout=idempotent\n`,
    );
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
