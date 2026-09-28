import assert from "node:assert/strict";
import test from "node:test";

import {
  RealWechatIdentityProvider,
  StubWechatIdentityProvider,
  WechatProviderError,
} from "../src/auth/wechat-provider.ts";

test("real WeChat provider returns only stable identity fields", async () => {
  const requestedUrls: string[] = [];
  const provider = new RealWechatIdentityProvider(
    "app-id",
    "app-secret",
    async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        JSON.stringify({
          openid: "openid-001",
          unionid: "unionid-001",
          session_key: "must-not-leave-provider",
        }),
        { status: 200 },
      );
    },
  );

  assert.deepEqual(await provider.exchangeCode("login-code"), {
    openid: "openid-001",
    unionid: "unionid-001",
  });
  const requestedUrl = new URL(requestedUrls[0]!);
  assert.equal(requestedUrl.searchParams.get("grant_type"), "authorization_code");
  assert.equal(requestedUrl.searchParams.get("js_code"), "login-code");
});

test("real WeChat provider maps invalid and rate-limited responses without leaking details", async () => {
  const invalidProvider = new RealWechatIdentityProvider(
    "app-id",
    "app-secret",
    async () =>
      new Response(JSON.stringify({ errcode: 40029, errmsg: "invalid code: secret-value" })),
  );
  const limitedProvider = new RealWechatIdentityProvider(
    "app-id",
    "app-secret",
    async () => new Response(JSON.stringify({ errcode: 45011, errmsg: "frequency limit" })),
  );

  await assert.rejects(
    invalidProvider.exchangeCode("bad-code"),
    (error: unknown) =>
      error instanceof WechatProviderError &&
      error.failure === "invalid_code" &&
      !error.message.includes("secret-value"),
  );
  await assert.rejects(
    limitedProvider.exchangeCode("limited-code"),
    (error: unknown) =>
      error instanceof WechatProviderError && error.failure === "rate_limited",
  );
});

test("stub provider only accepts explicit one-time test codes", async () => {
  const provider = new StubWechatIdentityProvider();
  assert.deepEqual(await provider.exchangeCode("test:user-001"), {
    openid: "stub-openid-user-001",
    unionid: "stub-unionid-user-001",
  });
  await assert.rejects(provider.exchangeCode("test:user-001"), /already used/);
  await assert.rejects(provider.exchangeCode("production-looking-code"), /invalid/);
});
