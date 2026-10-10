// Exercises the actual mini-program adapter against the local running API.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createBackendApi } = require('../miniprogram/services/api');
const { current } = require('../miniprogram/config/api');
function api(identity) {
  const storage = new Map();
  storage.set('tingyue.dev.stubLoginCode', `test:${identity}`);
  const runtime = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    login: ({ success }) => success({ code: 'local-platform-placeholder' }),
    request: options => {
      const controller = new AbortController();
      fetch(options.url, { method: options.method, headers: options.header,
        body: options.data === undefined ? undefined : JSON.stringify(options.data), signal: controller.signal })
        .then(async response => options.success({ statusCode: response.status, header: Object.fromEntries(response.headers), data: await response.json() }))
        .catch(options.fail);
      return { abort: () => controller.abort() };
    },
  };
  return createBackendApi({ runtime, configuration: current(runtime), makeId: prefix => `${prefix}-${randomUUID()}`, maxRetries: 0 });
}
async function main() {
  const name = `device-smoke-${randomUUID()}`;
  const a = api(name), b = api(`${name}-other`);
  try {
    const first = await a.loginWechat();
    assert.equal(a.progressSyncAvailable(), true);
    assert.equal(a.savedWordSyncAvailable(), true);
    await a.listProgress();
    await a.learningScore();
    await a.rankingOptions();
    await a.logout();
    assert.equal(a.isAuthenticated(), false);
    assert.equal((await a.loginWechat()).userId, first.userId);
    assert.notEqual((await b.loginWechat()).userId, first.userId);
    console.log('device-api.smoke.passed client=actual transport=wx-adapter backend=localhost relogin=same-user other-account=isolated progress=read score=read ranking=read');
  } finally { await Promise.allSettled([a.logout(), b.logout()]); }
}
main().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
