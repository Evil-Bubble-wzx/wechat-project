import { randomUUID } from "node:crypto";

import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import type { Pool, PoolClient } from "pg";

import { ApiError } from "../api/errors.ts";
import type { RuntimeConfig } from "../config.ts";
import {
  decodeKey,
  decrypt,
  encrypt,
  encryptPacked,
  hmacSha256,
  randomOpaqueToken,
  sha256,
} from "../security/crypto.ts";
import {
  type WechatIdentityProvider,
  WechatProviderError,
} from "./wechat-provider.ts";

export type SessionTokenResponse = {
  userId: string;
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};

export type AuthenticatedSession = {
  userId: string;
  sessionId: string;
};

export type CurrentUser = {
  userId: string;
  status: "active" | "disabled";
  profile: {
    campusId: string | null;
    grade: string | null;
    readingLevel: string | null;
  };
};

type IdempotencyRow = {
  request_hash: string;
  response_status: number;
  response_ciphertext: Buffer;
  response_iv: Buffer;
  response_auth_tag: Buffer;
};

type SessionRow = {
  id: string;
  user_id: string;
  token_family_id: string;
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  status: string;
  device_id: string | null;
};

export class SessionService {
  private readonly pool: Pool;
  private readonly provider: WechatIdentityProvider;
  private readonly config: RuntimeConfig;
  private readonly tokenSigningKey: Buffer;
  private readonly tokenVerificationKeys: Buffer[];
  private readonly identityHashKey: Buffer;
  private readonly dataEncryptionKey: Buffer;
  private readonly issuer = "tingyue-api";
  private readonly audience: string;

  constructor(
    pool: Pool,
    provider: WechatIdentityProvider,
    config: RuntimeConfig,
  ) {
    this.pool = pool;
    this.provider = provider;
    this.config = config;
    this.tokenSigningKey = decodeKey(config.auth.tokenSigningKeyBase64);
    this.tokenVerificationKeys = [
      this.tokenSigningKey,
      ...(config.auth.previousTokenSigningKeyBase64
        ? [decodeKey(config.auth.previousTokenSigningKeyBase64)]
        : []),
    ];
    this.identityHashKey = decodeKey(config.auth.identityHashKeyBase64);
    this.dataEncryptionKey = decodeKey(config.auth.dataEncryptionKeyBase64);
    this.audience = `tingyue-${config.appEnv}`;
  }

  private async readIdempotentResponse<T>(
    client: PoolClient,
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<T | null> {
    const result = await client.query<IdempotencyRow>(
      `SELECT request_hash, response_status, response_ciphertext, response_iv, response_auth_tag
       FROM idempotency_records
       WHERE scope = $1 AND idempotency_key = $2 AND expires_at > now()`,
      [scope, key],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.request_hash.trim() !== requestHash) {
      throw new ApiError(
        "IDEMPOTENCY_KEY_REUSED",
        409,
        false,
        "Idempotency key was already used with a different request",
      );
    }
    const plaintext = decrypt(
      {
        ciphertext: row.response_ciphertext,
        iv: row.response_iv,
        authTag: row.response_auth_tag,
      },
      this.dataEncryptionKey,
    );
    return JSON.parse(plaintext.toString("utf8")) as T;
  }

  private async saveIdempotentResponse(
    client: PoolClient,
    scope: string,
    key: string,
    requestHash: string,
    status: number,
    response: unknown,
    expiresAt: Date,
  ): Promise<void> {
    const encrypted = encrypt(JSON.stringify(response), this.dataEncryptionKey);
    await client.query(
      `INSERT INTO idempotency_records (
         scope, idempotency_key, request_hash, response_status,
         response_ciphertext, response_iv, response_auth_tag, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        scope,
        key,
        requestHash,
        status,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        expiresAt,
      ],
    );
  }

  private async issueAccessToken(
    userId: string,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = now + this.config.auth.accessTokenTtlSeconds;
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(expiresAtSeconds)
      .setJti(randomUUID())
      .sign(this.tokenSigningKey);
    return { token, expiresAt: new Date(expiresAtSeconds * 1000) };
  }

  private async createSession(
    client: PoolClient,
    userId: string,
    deviceId: string | undefined,
    tokenFamilyId: string = randomUUID(),
  ): Promise<SessionTokenResponse> {
    const sessionId = randomUUID();
    const refreshToken = randomOpaqueToken();
    const refreshTokenExpiresAt = new Date(
      Date.now() + this.config.auth.refreshTokenTtlSeconds * 1000,
    );
    await client.query(
      `INSERT INTO user_sessions (
         id, user_id, token_family_id, refresh_token_hash, device_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sessionId,
        userId,
        tokenFamilyId,
        sha256(refreshToken),
        deviceId ?? null,
        refreshTokenExpiresAt,
      ],
    );
    const accessToken = await this.issueAccessToken(userId, sessionId);
    return {
      userId,
      sessionId,
      accessToken: accessToken.token,
      accessTokenExpiresAt: accessToken.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    };
  }

  private mapProviderError(error: unknown): never {
    if (error instanceof WechatProviderError) {
      if (error.failure === "invalid_code") {
        throw new ApiError("AUTH_CODE_INVALID", 401, false, "WeChat login code is invalid");
      }
      if (error.failure === "rate_limited") {
        throw new ApiError("RATE_LIMITED", 429, true, "WeChat login is rate limited");
      }
      throw new ApiError(
        "DEPENDENCY_UNAVAILABLE",
        503,
        true,
        "WeChat login service is unavailable",
      );
    }
    throw error;
  }

  async createWechatSession(input: {
    code: string;
    deviceId?: string;
    idempotencyKey: string;
  }): Promise<SessionTokenResponse> {
    const scope = "session.wechat";
    const requestHash = sha256(
      JSON.stringify({ code: input.code, deviceId: input.deviceId ?? null }),
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${scope}:${input.idempotencyKey}`,
      ]);
      const previous = await this.readIdempotentResponse<SessionTokenResponse>(
        client,
        scope,
        input.idempotencyKey,
        requestHash,
      );
      if (previous) {
        await client.query("COMMIT");
        return previous;
      }

      let identity;
      try {
        identity = await this.provider.exchangeCode(input.code);
      } catch (error) {
        this.mapProviderError(error);
      }

      const openidLookupHash = hmacSha256(identity.openid, this.identityHashKey);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `wechat:${this.config.auth.wechatAppId}:${openidLookupHash}`,
      ]);
      const existing = await client.query<{ user_id: string; status: string }>(
        `SELECT wi.user_id, u.status
         FROM wechat_identities wi
         JOIN users u ON u.id = wi.user_id
         WHERE wi.app_id = $1 AND wi.openid_lookup_hash = $2
         FOR UPDATE OF wi, u`,
        [this.config.auth.wechatAppId, openidLookupHash],
      );

      let userId: string;
      if (existing.rows[0]) {
        if (existing.rows[0].status !== "active") {
          throw new ApiError("FORBIDDEN", 403, false, "User account is disabled");
        }
        userId = existing.rows[0].user_id;
      } else {
        const user = await client.query<{ id: string }>(
          "INSERT INTO users DEFAULT VALUES RETURNING id",
        );
        userId = user.rows[0]!.id;
        await client.query(
          `INSERT INTO wechat_identities (
             user_id, app_id, openid_lookup_hash, openid_ciphertext,
             unionid_lookup_hash, unionid_ciphertext
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            userId,
            this.config.auth.wechatAppId,
            openidLookupHash,
            encryptPacked(identity.openid, this.dataEncryptionKey),
            identity.unionid ? hmacSha256(identity.unionid, this.identityHashKey) : null,
            identity.unionid
              ? encryptPacked(identity.unionid, this.dataEncryptionKey)
              : null,
          ],
        );
      }

      const response = await this.createSession(client, userId, input.deviceId);
      await this.saveIdempotentResponse(
        client,
        scope,
        input.idempotencyKey,
        requestHash,
        201,
        response,
        new Date(response.refreshTokenExpiresAt),
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshSession(input: {
    refreshToken: string;
    idempotencyKey: string;
    requestId?: string;
  }): Promise<SessionTokenResponse> {
    const scope = "session.refresh";
    const requestHash = sha256(input.refreshToken);
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${scope}:${input.idempotencyKey}`,
      ]);
      const previous = await this.readIdempotentResponse<SessionTokenResponse>(
        client,
        scope,
        input.idempotencyKey,
        requestHash,
      );
      if (previous) {
        await client.query("COMMIT");
        transactionOpen = false;
        return previous;
      }

      const sessions = await client.query<SessionRow>(
        `SELECT s.id, s.user_id, s.token_family_id, s.expires_at,
                s.rotated_at, s.revoked_at, s.device_id, u.status
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.refresh_token_hash = $1
         FOR UPDATE OF s, u`,
        [sha256(input.refreshToken)],
      );
      const session = sessions.rows[0];
      if (!session) {
        throw new ApiError("UNAUTHENTICATED", 401, false, "Refresh token is invalid");
      }
      if (session.rotated_at) {
        await client.query(
          `UPDATE user_sessions
           SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, 'refresh_token_reuse')
           WHERE token_family_id = $1`,
          [session.token_family_id],
        );
        await client.query(
          `INSERT INTO audit_events (
             actor_type, actor_id, action, target_type, target_id, request_id, metadata
           ) VALUES ('service', 'session-service', 'refresh_token_reuse', 'session_family', $1, $2, $3)`,
          [
            session.token_family_id,
            input.requestId ?? input.idempotencyKey,
            JSON.stringify({ userId: session.user_id }),
          ],
        );
        await client.query("COMMIT");
        transactionOpen = false;
        throw new ApiError(
          "REFRESH_TOKEN_REUSED",
          401,
          false,
          "Refresh token was already rotated; the session family was revoked",
        );
      }
      if (session.revoked_at || session.expires_at.getTime() <= Date.now()) {
        throw new ApiError("UNAUTHENTICATED", 401, false, "Refresh token is expired or revoked");
      }
      if (session.status !== "active") {
        throw new ApiError("FORBIDDEN", 403, false, "User account is disabled");
      }

      const response = await this.createSession(
        client,
        session.user_id,
        session.device_id ?? undefined,
        session.token_family_id,
      );
      await client.query(
        `UPDATE user_sessions
         SET rotated_at = now(), replaced_by_session_id = $1, last_used_at = now()
         WHERE id = $2`,
        [response.sessionId, session.id],
      );
      await this.saveIdempotentResponse(
        client,
        scope,
        input.idempotencyKey,
        requestHash,
        200,
        response,
        new Date(response.refreshTokenExpiresAt),
      );
      await client.query("COMMIT");
      transactionOpen = false;
      return response;
    } catch (error) {
      if (transactionOpen) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticateAccessToken(token: string): Promise<AuthenticatedSession> {
    const claims = await this.verifyAccessTokenClaims(token);
    const result = await this.pool.query<{ status: string; revoked_at: Date | null }>(
      `SELECT u.status, s.revoked_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [claims.sessionId, claims.userId],
    );
    const row = result.rows[0];
    if (!row || row.revoked_at) {
      throw new ApiError("UNAUTHENTICATED", 401, false, "Session is revoked or missing");
    }
    if (row.status !== "active") {
      throw new ApiError("FORBIDDEN", 403, false, "User account is disabled");
    }
    return claims;
  }

  private async verifyAccessTokenClaims(token: string): Promise<AuthenticatedSession> {
    let payload;
    let expired = false;
    for (const key of this.tokenVerificationKeys) {
      try {
        ({ payload } = await jwtVerify(token, key, {
          issuer: this.issuer,
          audience: this.audience,
          algorithms: ["HS256"],
        }));
        break;
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) expired = true;
      }
    }
    if (!payload && expired) throw new ApiError("ACCESS_TOKEN_EXPIRED", 401, false, "Access token has expired");
    if (!payload) throw new ApiError("UNAUTHENTICATED", 401, false, "Access token is invalid");
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      throw new ApiError("UNAUTHENTICATED", 401, false, "Access token claims are invalid");
    }
    return { userId: payload.sub, sessionId: payload.sid };
  }

  async revokeSession(input: {
    accessToken: string;
    idempotencyKey: string;
  }): Promise<void> {
    const scope = "session.revoke";
    const requestHash = sha256(input.accessToken);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${scope}:${input.idempotencyKey}`,
      ]);
      const previous = await this.readIdempotentResponse<{ status: "revoked" }>(
        client,
        scope,
        input.idempotencyKey,
        requestHash,
      );
      if (previous) {
        await client.query("COMMIT");
        return;
      }

      const session = await this.verifyAccessTokenClaims(input.accessToken);
      const active = await client.query<{ status: string; revoked_at: Date | null }>(
        `SELECT u.status, s.revoked_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.user_id = $2
         FOR UPDATE OF s, u`,
        [session.sessionId, session.userId],
      );
      const row = active.rows[0];
      if (!row || row.revoked_at) {
        throw new ApiError("UNAUTHENTICATED", 401, false, "Session is revoked or missing");
      }
      if (row.status !== "active") {
        throw new ApiError("FORBIDDEN", 403, false, "User account is disabled");
      }
      await client.query(
        `UPDATE user_sessions
         SET revoked_at = now(), revoke_reason = 'user_logout'
         WHERE id = $1 AND user_id = $2`,
        [session.sessionId, session.userId],
      );
      await this.saveIdempotentResponse(
        client,
        scope,
        input.idempotencyKey,
        requestHash,
        200,
        { status: "revoked" },
        new Date(Date.now() + 86_400_000),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCurrentUser(session: AuthenticatedSession): Promise<CurrentUser> {
    const result = await this.pool.query<{
      user_id: string;
      status: "active" | "disabled" | "deleted";
      campus_id: string | null;
      grade: string | null;
      reading_level: string | null;
    }>(
      `SELECT u.id AS user_id, u.status, p.campus_id, p.grade, p.reading_level
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [session.userId],
    );
    const user = result.rows[0];
    if (!user || user.status === "deleted") {
      throw new ApiError("UNAUTHENTICATED", 401, false, "User is unavailable");
    }
    return {
      userId: user.user_id,
      status: user.status,
      profile: {
        campusId: user.campus_id,
        grade: user.grade,
        readingLevel: user.reading_level,
      },
    };
  }

  async assertContentAdmin(userId: string): Promise<void> {
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM user_roles
         WHERE user_id = $1 AND role IN ('content_admin', 'operations_admin')
       ) AS allowed`,
      [userId],
    );
    if (!result.rows[0]?.allowed) {
      throw new ApiError("FORBIDDEN", 403, false, "Content administrator role is required");
    }
  }
}
