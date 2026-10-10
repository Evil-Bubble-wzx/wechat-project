// Generate private local configuration once; never print secret values.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const backend = path.resolve(__dirname, '..');
const target = path.join(backend, '.env.device-local');
if (fs.existsSync(target)) {
  console.log('Existing device-local configuration preserved.');
} else {
  const secret = () => randomBytes(24).toString('hex');
  const db = secret(), redis = secret(), root = secret(), storage = secret();
  const values = {
    APP_ENV: 'local', API_HOST: '127.0.0.1', API_PORT: '3100',
    DEVICE_DB_PASSWORD: db, DEVICE_REDIS_PASSWORD: redis, DEVICE_STORAGE_ROOT_PASSWORD: root,
    DATABASE_URL: `postgresql://tingyue:${db}@127.0.0.1:55433/tingyue`,
    REDIS_URL: `redis://:${redis}@127.0.0.1:56379`,
    OBJECT_STORAGE_ENDPOINT: '127.0.0.1', OBJECT_STORAGE_PORT: '59000', OBJECT_STORAGE_USE_SSL: 'false',
    OBJECT_STORAGE_ACCESS_KEY: 'tingyue-device-app', OBJECT_STORAGE_SECRET_KEY: storage,
    OBJECT_STORAGE_BUCKET_INCOMING: 'tingyue-incoming', OBJECT_STORAGE_BUCKET_PUBLISHED: 'tingyue-published',
    INGESTION_QUEUE_NAME: 'device-local-ingestion', WORKER_CONCURRENCY: '1', WECHAT_PROVIDER: 'stub',
    METRICS_BEARER_TOKEN: secret(), TOKEN_SIGNING_KEY_BASE64: randomBytes(32).toString('base64'),
    IDENTITY_HASH_KEY_BASE64: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
  };
  fs.writeFileSync(target, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Private device-local configuration generated (ignored by Git).');
}
