export type WechatIdentity = {
  openid: string;
  unionid?: string;
};

export type WechatProviderFailure = "invalid_code" | "rate_limited" | "unavailable";

export class WechatProviderError extends Error {
  readonly failure: WechatProviderFailure;

  constructor(
    failure: WechatProviderFailure,
    message: string,
  ) {
    super(message);
    this.name = "WechatProviderError";
    this.failure = failure;
  }
}

export interface WechatIdentityProvider {
  exchangeCode(code: string): Promise<WechatIdentity>;
}

type WechatCode2SessionResponse = {
  openid?: unknown;
  unionid?: unknown;
  session_key?: unknown;
  errcode?: unknown;
  errmsg?: unknown;
};

export class RealWechatIdentityProvider implements WechatIdentityProvider {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    appId: string,
    appSecret: string,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetchImplementation = fetchImplementation;
  }

  async exchangeCode(code: string): Promise<WechatIdentity> {
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", this.appId);
    url.searchParams.set("secret", this.appSecret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");

    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new WechatProviderError("unavailable", "WeChat login service is unavailable");
    }
    if (!response.ok) {
      throw new WechatProviderError("unavailable", "WeChat login service is unavailable");
    }

    let payload: WechatCode2SessionResponse;
    try {
      payload = (await response.json()) as WechatCode2SessionResponse;
    } catch {
      throw new WechatProviderError("unavailable", "WeChat login response is invalid");
    }

    if (payload.errcode !== undefined && payload.errcode !== 0) {
      if (payload.errcode === 45011) {
        throw new WechatProviderError("rate_limited", "WeChat login rate limit exceeded");
      }
      if (payload.errcode === -1) {
        throw new WechatProviderError("unavailable", "WeChat login service is busy");
      }
      throw new WechatProviderError("invalid_code", "WeChat login code is invalid");
    }
    if (typeof payload.openid !== "string" || payload.openid.length === 0) {
      throw new WechatProviderError("unavailable", "WeChat login response has no identity");
    }

    return {
      openid: payload.openid,
      unionid: typeof payload.unionid === "string" ? payload.unionid : undefined,
    };
  }
}

export class StubWechatIdentityProvider implements WechatIdentityProvider {
  private readonly usedCodes = new Set<string>();

  async exchangeCode(code: string): Promise<WechatIdentity> {
    if (!code.startsWith("test:") || code.length < 8 || this.usedCodes.has(code)) {
      throw new WechatProviderError("invalid_code", "Test login code is invalid or already used");
    }
    this.usedCodes.add(code);
    const stableTestIdentity = code.slice("test:".length);
    return {
      openid: `stub-openid-${stableTestIdentity}`,
      unionid: `stub-unionid-${stableTestIdentity}`,
    };
  }
}
