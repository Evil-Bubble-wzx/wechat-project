export type AppEnvironment = "local" | "dev" | "test" | "prod";
export type WechatProviderMode = "stub" | "real";

export type RuntimeConfig = {
  appEnv: AppEnvironment;
  apiHost: string;
  apiPort: number;
  databaseUrl: string;
  redisUrl: string;
  objectStorage: {
    endpoint: string;
    port: number;
    useSsl: boolean;
    accessKey: string;
    secretKey: string;
    incomingBucket: string;
    publishedBucket: string;
  };
  ingestionQueueName: string;
  workerConcurrency: number;
  ffprobePath: string;
  observability: {
    metricsBearerToken: string;
  };
  auth: {
    wechatProvider: WechatProviderMode;
    wechatAppId: string;
    wechatAppSecret: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    tokenSigningKeyBase64: string;
    previousTokenSigningKeyBase64: string | null;
    identityHashKeyBase64: string;
    dataEncryptionKeyBase64: string;
  };
};

const localTokenSigningKey = "dGluZ3l1ZS1sb2NhbC10b2tlbi1rZXktMzJieXRlcyE=";
const localIdentityHashKey = "dGluZ3l1ZS1sb2NhbC1pZGVudC1rZXktMzJieXRlcyE=";
const localDataEncryptionKey = "dGluZ3l1ZS1sb2NhbC1kYXRhLWtleS0tMzJieXRlcyE=";

function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[key];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${key} must be true or false`);
}

function readEnvironment(env: NodeJS.ProcessEnv): AppEnvironment {
  const value = env.APP_ENV || "local";
  if (value === "local" || value === "dev" || value === "test" || value === "prod") {
    return value;
  }
  throw new Error("APP_ENV must be local, dev, test, or prod");
}

function readWechatProvider(env: NodeJS.ProcessEnv): WechatProviderMode {
  const value = env.WECHAT_PROVIDER || "stub";
  if (value === "stub" || value === "real") return value;
  throw new Error("WECHAT_PROVIDER must be stub or real");
}

function validateBase64Key(value: string, key: string): void {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${key} must be canonical base64 for exactly 32 bytes`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const appEnv = readEnvironment(env);
  const config: RuntimeConfig = {
    appEnv,
    apiHost: env.API_HOST || "127.0.0.1",
    apiPort: readInteger(env, "API_PORT", 3100, 1, 65535),
    databaseUrl: env.DATABASE_URL || "postgresql://tingyue:tingyue-local@127.0.0.1:5432/tingyue",
    redisUrl: env.REDIS_URL || "redis://127.0.0.1:6379",
    objectStorage: {
      endpoint: env.OBJECT_STORAGE_ENDPOINT || "127.0.0.1",
      port: readInteger(env, "OBJECT_STORAGE_PORT", 9000, 1, 65535),
      useSsl: readBoolean(env, "OBJECT_STORAGE_USE_SSL", false),
      accessKey: env.OBJECT_STORAGE_ACCESS_KEY || "tingyue-app-local",
      secretKey: env.OBJECT_STORAGE_SECRET_KEY || "tingyue-app-secret-local",
      incomingBucket: env.OBJECT_STORAGE_BUCKET_INCOMING || "tingyue-incoming",
      publishedBucket: env.OBJECT_STORAGE_BUCKET_PUBLISHED || "tingyue-published",
    },
    ingestionQueueName: env.INGESTION_QUEUE_NAME || "content-ingestion",
    workerConcurrency: readInteger(env, "WORKER_CONCURRENCY", 2, 1, 64),
    ffprobePath: env.FFPROBE_PATH || "ffprobe",
    observability: {
      metricsBearerToken: env.METRICS_BEARER_TOKEN || "local-metrics-token-change-me",
    },
    auth: {
      wechatProvider: readWechatProvider(env),
      wechatAppId: env.WECHAT_APP_ID || "local-test-miniapp",
      wechatAppSecret: env.WECHAT_APP_SECRET || "local-test-secret",
      accessTokenTtlSeconds: readInteger(
        env,
        "ACCESS_TOKEN_TTL_SECONDS",
        900,
        60,
        86_400,
      ),
      refreshTokenTtlSeconds: readInteger(
        env,
        "REFRESH_TOKEN_TTL_SECONDS",
        2_592_000,
        3_600,
        31_536_000,
      ),
      tokenSigningKeyBase64: env.TOKEN_SIGNING_KEY_BASE64 || localTokenSigningKey,
      previousTokenSigningKeyBase64: env.PREVIOUS_TOKEN_SIGNING_KEY_BASE64 || null,
      identityHashKeyBase64: env.IDENTITY_HASH_KEY_BASE64 || localIdentityHashKey,
      dataEncryptionKeyBase64: env.DATA_ENCRYPTION_KEY_BASE64 || localDataEncryptionKey,
    },
  };

  validateBase64Key(config.auth.tokenSigningKeyBase64, "TOKEN_SIGNING_KEY_BASE64");
  if (config.auth.previousTokenSigningKeyBase64) {
    validateBase64Key(config.auth.previousTokenSigningKeyBase64, "PREVIOUS_TOKEN_SIGNING_KEY_BASE64");
  }
  validateBase64Key(config.auth.identityHashKeyBase64, "IDENTITY_HASH_KEY_BASE64");
  validateBase64Key(config.auth.dataEncryptionKeyBase64, "DATA_ENCRYPTION_KEY_BASE64");

  if (config.auth.wechatProvider === "real") {
    if (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET) {
      throw new Error("Real WeChat provider requires WECHAT_APP_ID and WECHAT_APP_SECRET");
    }
  }

  if (appEnv === "prod") {
    const unsafeDefaults = [
      config.objectStorage.accessKey === "tingyue-app-local",
      config.objectStorage.secretKey === "tingyue-app-secret-local",
      config.databaseUrl.includes("tingyue-local"),
      config.auth.wechatProvider !== "real",
      config.auth.wechatAppId === "local-test-miniapp",
      config.auth.wechatAppSecret === "local-test-secret",
      config.auth.tokenSigningKeyBase64 === localTokenSigningKey,
      config.auth.previousTokenSigningKeyBase64 === localTokenSigningKey,
      config.auth.identityHashKeyBase64 === localIdentityHashKey,
      config.auth.dataEncryptionKeyBase64 === localDataEncryptionKey,
      config.observability.metricsBearerToken === "local-metrics-token-change-me",
    ];
    if (unsafeDefaults.some(Boolean)) {
      throw new Error("Production configuration cannot use local default credentials");
    }
  }

  return config;
}
