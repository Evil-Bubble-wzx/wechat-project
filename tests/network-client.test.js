const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createApiClient, normalizeBaseUrl, backoffDelay } = require('../miniprogram/services/network/client')
const { ERROR_KINDS, ApiClientError, toUserMessage } = require('../miniprogram/services/network/errors')
const { createMemoryTokenStore } = require('../miniprogram/services/network/token-store')
const { createWxTransport } = require('../miniprogram/services/network/wx-transport')

function client(overrides = {}) {
  return createApiClient(Object.assign({
    enabled: true,
    baseUrl: 'https://api.test.invalid/api/v1',
    transport: async () => ({ statusCode: 200, data: { ok: true } }),
    sleep: async () => {},
    random: () => 0
  }, overrides))
}

test('network layer is fail-closed until explicitly enabled', async () => {
  const api = createApiClient({ transport: async () => ({ statusCode: 200 }) })
  await assert.rejects(api.request({ path: '/works' }), error => error.kind === ERROR_KINDS.DISABLED)
})

test('configuration accepts HTTPS and local HTTP only', async () => {
  assert.equal(normalizeBaseUrl('https://example.test/api/v1/'), 'https://example.test/api/v1')
  assert.equal(normalizeBaseUrl('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeBaseUrl('http://api.example.test'), null)
  await assert.rejects(client({ baseUrl: 'http://api.example.test' }).request({ path: '/works' }), error => error.kind === ERROR_KINDS.INVALID_CONFIG)
  await assert.rejects(client().request({ path: 'works' }), error => error.kind === ERROR_KINDS.INVALID_CONFIG)
})

test('successful requests inject bearer token and preserve requestId', async () => {
  const tokenStore = createMemoryTokenStore(' access-secret ')
  let seen
  const api = client({
    tokenStore,
    transport: async request => {
      seen = request
      return { statusCode: 200, data: { works: [] }, header: { 'X-Request-Id': 'req-1' } }
    }
  })
  const result = await api.request({ path: '/works', headers: { 'X-Client': 'test' } })
  assert.equal(seen.url, 'https://api.test.invalid/api/v1/works')
  assert.equal(seen.headers.Authorization, 'Bearer access-secret')
  assert.equal(seen.headers['X-Client'], 'test')
  assert.equal(result.requestId, 'req-1')
})

test('memory token store does not call persistent storage and logout clears it', () => {
  const store = createMemoryTokenStore('one')
  const api = client({ tokenStore: store })
  assert.equal(store.getAccessToken(), 'one')
  store.setAccessToken('two')
  assert.equal(store.getAccessToken(), 'two')
  api.logout()
  assert.equal(store.getAccessToken(), null)
})

test('GET retries retryable gateway failures twice with exponential backoff', async () => {
  const delays = []
  let attempts = 0
  const api = client({
    transport: async () => {
      attempts += 1
      if (attempts < 3) return { statusCode: 503, data: { error: { code: 'UPSTREAM_BUSY' } }, header: { 'x-request-id': 'req-busy' } }
      return { statusCode: 200, data: { ok: true } }
    },
    sleep: async delay => { delays.push(delay) }
  })
  assert.deepEqual((await api.request({ path: '/works' })).data, { ok: true })
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [200, 400])
  assert.equal(backoffDelay(1, () => 0.5), 450)
})

test('POST is never automatically retried', async () => {
  let attempts = 0
  const api = client({ transport: async () => { attempts += 1; throw new Error('offline') } })
  await assert.rejects(api.request({ method: 'POST', path: '/me/quiz-attempts', body: {} }), error => error.kind === ERROR_KINDS.NETWORK)
  assert.equal(attempts, 1)
})

test('GET retries network failures but not ordinary 4xx responses', async () => {
  let attempts = 0
  const api = client({
    transport: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('offline')
      return { statusCode: 404, data: { error: { code: 'WORK_NOT_FOUND' }, requestId: 'req-404' } }
    }
  })
  await assert.rejects(api.request({ path: '/works/missing' }), error => {
    assert.equal(error.kind, ERROR_KINDS.SERVER)
    assert.equal(error.serverCode, 'WORK_NOT_FOUND')
    assert.equal(error.requestId, 'req-404')
    return true
  })
  assert.equal(attempts, 2)
})

test('timeout has a stable kind and GET retry limit', async () => {
  let attempts = 0
  const api = client({
    maxRetries: 1,
    timeoutMs: 5,
    transport: () => { attempts += 1; return new Promise(() => {}) }
  })
  await assert.rejects(api.request({ path: '/slow' }), error => error.kind === ERROR_KINDS.TIMEOUT)
  assert.equal(attempts, 2)
})

test('AbortSignal cancellation is never retried', async () => {
  const controller = new AbortController()
  let attempts = 0
  const api = client({ transport: () => { attempts += 1; return new Promise(() => {}) } })
  const pending = api.request({ path: '/works', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, error => error.kind === ERROR_KINDS.CANCELLED)
  assert.equal(attempts, 1)
})

test('concurrent 401 responses share one refresh and retry with the new token', async () => {
  const tokenStore = createMemoryTokenStore('expired')
  let refreshCalls = 0
  const seenTokens = []
  const api = client({
    tokenStore,
    refreshSession: async () => {
      refreshCalls += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return { accessToken: 'renewed' }
    },
    transport: async request => {
      seenTokens.push(request.headers.Authorization)
      return request.headers.Authorization === 'Bearer renewed'
        ? { statusCode: 200, data: { ok: true } }
        : { statusCode: 401, data: { error: { code: 'ACCESS_EXPIRED' } } }
    }
  })
  const results = await Promise.all([api.request({ path: '/me' }), api.request({ path: '/works' })])
  assert.equal(refreshCalls, 1)
  assert.ok(results.every(result => result.data.ok))
  assert.deepEqual(seenTokens.sort(), ['Bearer expired', 'Bearer expired', 'Bearer renewed', 'Bearer renewed'].sort())
})

test('failed refresh clears token and returns a stable network error', async () => {
  const tokenStore = createMemoryTokenStore('expired')
  const api = client({
    tokenStore,
    refreshSession: async () => { throw new Error('offline') },
    transport: async () => ({ statusCode: 401, data: { error: { code: 'ACCESS_EXPIRED' } } })
  })
  await assert.rejects(api.request({ path: '/me' }), error => error.kind === ERROR_KINDS.NETWORK)
  assert.equal(tokenStore.getAccessToken(), null)
})

test('logout prevents a late refresh response from restoring the token', async () => {
  const tokenStore = createMemoryTokenStore('expired')
  let finishRefresh
  const api = client({
    tokenStore,
    refreshSession: () => new Promise(resolve => { finishRefresh = resolve }),
    transport: async () => ({ statusCode: 401, data: { error: { code: 'ACCESS_EXPIRED' } } })
  })
  const pending = api.request({ path: '/me' })
  await new Promise(resolve => setImmediate(resolve))
  api.logout()
  finishRefresh({ accessToken: 'must-not-return' })
  await assert.rejects(pending, error => error.kind === ERROR_KINDS.CANCELLED)
  assert.equal(tokenStore.getAccessToken(), null)
})

test('malformed transport response is classified as a contract error', async () => {
  await assert.rejects(client({ transport: async () => ({ data: {} }) }).request({ path: '/works' }), error => error.kind === ERROR_KINDS.CONTRACT)
})

test('user messages never expose server details or tokens', () => {
  const error = new ApiClientError(ERROR_KINDS.SERVER, { serverCode: 'RAW_INTERNAL_DETAIL', message: 'secret token abc' })
  assert.equal(toUserMessage(error), '服务暂时不可用，请稍后重试')
  assert.equal(toUserMessage(new ApiClientError(ERROR_KINDS.UNAUTHORIZED)), '登录状态已失效，请重新登录')
})

test('wx transport maps request fields and aborts the request task', async () => {
  let received
  let aborted = false
  const fakeWx = {
    request(options) {
      received = options
      return { abort() { aborted = true; options.fail({ errMsg: 'request:fail abort' }) } }
    }
  }
  const controller = new AbortController()
  const pending = createWxTransport(fakeWx)({
    url: 'https://api.test.invalid/api/v1/me', method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: 5000, signal: controller.signal
  })
  assert.equal(received.header.Accept, 'application/json')
  assert.equal(received.timeout, 5000)
  controller.abort()
  await assert.rejects(pending, /abort|cancel/i)
  assert.equal(aborted, true)
})

test('wx transport resolves the unmodified platform response', async () => {
  const expected = { statusCode: 200, data: { ok: true }, header: { 'x-request-id': 'req-wx' } }
  const transport = createWxTransport({ request(options) { options.success(expected); return { abort() {} } } })
  assert.equal(await transport({ url: 'https://example.test', method: 'GET', headers: {}, timeoutMs: 1000 }), expected)
})
