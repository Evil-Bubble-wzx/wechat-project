const apiConfig = require('../config/api')
const { createApiClient } = require('./network/client')
const { createMemoryTokenStore } = require('./network/token-store')
const { createWxTransport } = require('./network/wx-transport')
const host = require('./host')

function createBackendApi(options = {}) {
  const runtime = options.runtime || (typeof wx === 'undefined' ? null : wx)
  const configuration = options.configuration || apiConfig.current(runtime)
  const transport = options.transport || (runtime && typeof runtime.request === 'function' ? createWxTransport(runtime) : null)
  const tokenStore = options.tokenStore || createMemoryTokenStore()
  const makeId = options.makeId || randomId
  let session = null
  let user = null
  let serverContractVersion = null

  const publicClient = createApiClient({
    enabled:configuration.enabled,
    baseUrl:configuration.apiRoot,
    transport,
    tokenStore:createMemoryTokenStore(),
    timeoutMs:options.timeoutMs,
    maxRetries:options.maxRetries,
    sleep:options.sleep,
    random:options.random
  })
  const client = createApiClient({
    enabled:configuration.enabled,
    baseUrl:configuration.apiRoot,
    transport,
    tokenStore,
    timeoutMs:options.timeoutMs,
    maxRetries:options.maxRetries,
    sleep:options.sleep,
    random:options.random,
    refreshSession:async () => {
      if (!session || !session.refreshToken) throw new Error('No refresh session')
      const result = await publicClient.request({
        method:'POST',
        path:'/session/refresh',
        headers:mutationHeaders(makeId('refresh')),
        body:{ refreshToken:session.refreshToken }
      })
      session = normalizeSession(result.data, user)
      return session
    }
  })

  async function loginWechat() {
    const platformCode = await getWechatCode(runtime)
    const code = configuration.development && configuration.stubLoginCode ? configuration.stubLoginCode : platformCode
    const result = await publicClient.request({
      method:'POST',
      path:'/session/wechat',
      headers:mutationHeaders(makeId('login')),
      body:{ code, deviceId:getDeviceId(runtime, makeId) }
    })
    session = normalizeSession(result.data)
    tokenStore.setAccessToken(session.accessToken)
    user = await getMe()
    host.setAccountScope(user.userId)
    return user
  }

  async function getMe() {
    const result = await client.request({ path:'/me' })
    serverContractVersion = result.contractVersion
    user = result.data
    return user
  }

  async function logout() {
    try {
      if (tokenStore.getAccessToken()) await client.request({ method:'DELETE', path:'/session/current', headers:{ 'Idempotency-Key':makeId('logout') } })
    } finally {
      session = null
      user = null
      serverContractVersion = null
      host.setAccountScope(null)
      client.logout()
      publicClient.logout()
    }
  }

  const get = async (path, query) => (await client.request({ path:path + queryString(query) })).data
  const post = async (path, body, idempotencyKey) => (await client.request({ method:'POST', path, headers:mutationHeaders(idempotencyKey || makeId('mutation')), body })).data
  const put = async (path, body, idempotencyKey) => (await client.request({ method:'PUT', path, headers:mutationHeaders(idempotencyKey || makeId('mutation')), body })).data

  return {
    contractVersion:configuration.contractVersion,
    available:() => configuration.enabled === true,
    isAuthenticated:() => !!(session && tokenStore.getAccessToken()),
    currentUser:() => user,
    currentSession:() => session ? Object.assign({}, session, { accessToken:undefined, refreshToken:undefined }) : null,
    progressSyncAvailable:() => supportsContract(serverContractVersion, 1, 2),
    savedWordSyncAvailable:() => supportsContract(serverContractVersion, 1, 3),
    loginWechat,
    getMe,
    logout,
    listWorks:(cursor, limit = 50) => get('/works', { cursor, limit }),
    getWork:workId => get('/works/' + encodeURIComponent(workId)),
    getManifest:(pieceId, contentVersion) => get('/pieces/' + encodeURIComponent(pieceId) + '/manifest', { contentVersion }),
    submitQuiz:attempt => post('/me/quiz-attempts', quizPayload(attempt), attempt.attemptId),
    localImport:request => post('/me/local-import', request, request.snapshotId),
    putProgress:(pieceId, request) => put('/me/progress/' + encodeURIComponent(pieceId), request, request.mutationId),
    getProgress:pieceId => get('/me/progress/' + encodeURIComponent(pieceId)),
    listProgress:(cursor, limit = 50) => get('/me/progress', { cursor, limit }),
    savedWordSync:request => post('/me/words/sync', request, request.batchId),
    rankingOptions:() => get('/ranking-options'),
    rankings:filters => get('/rankings', rankingQuery(filters)),
    rankingDetail:(participantId, filters) => get('/rankings/' + encodeURIComponent(participantId) + '/quizzes', rankingQuery(filters)),
    _tokenStore:tokenStore
  }
}

function normalizeSession(value, existingUser = null) {
  if (!value || !value.accessToken || !value.refreshToken) throw new Error('Invalid session response')
  return Object.assign({}, value, { user:existingUser || null })
}
function supportsContract(value, major, minor) { const match=/^api-contract-v(\d+)\.(\d+)\.(\d+)$/.exec(String(value||''));return !!(match&&Number(match[1])===major&&Number(match[2])>=minor) }
function mutationHeaders(key) { return { 'Content-Type':'application/json', 'Idempotency-Key':key } }
function queryString(values = {}) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '')
  return entries.length ? '?' + entries.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value))).join('&') : ''
}
function rankingQuery(filters = {}) {
  return { campusId:filters.campusId, periodType:filters.periodType, periodKey:filters.periodKey, grade:filters.grade, level:filters.level, cursor:filters.cursor, limit:filters.limit || 50 }
}
function quizPayload(attempt) {
  return {
    schemaVersion:attempt.schemaVersion,
    attemptId:attempt.attemptId,
    workId:attempt.workId,
    pieceId:attempt.pieceId,
    contentVersion:attempt.contentVersion,
    quizVersion:attempt.quizVersion,
    questionIds:attempt.questionIds,
    selectedOptions:attempt.selectedOptions,
    startedAt:attempt.startedAt,
    submittedAt:attempt.submittedAt
  }
}
function randomId(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) }
function getWechatCode(runtime) {
  return new Promise((resolve, reject) => {
    if (!runtime || typeof runtime.login !== 'function') return reject(new Error('wx.login is unavailable'))
    runtime.login({ success:result => result && result.code ? resolve(result.code) : reject(new Error('wx.login returned no code')), fail:reject })
  })
}
function getDeviceId(runtime, makeId) {
  const key = 'tingyue.device.v1'
  try {
    const existing = runtime.getStorageSync(key)
    if (existing) return existing
    const created = makeId('device')
    runtime.setStorageSync(key, created)
    return created
  } catch (_) { return makeId('device') }
}

let singleton = null
let singletonSignature = null
function active() {
  const configuration = apiConfig.current()
  const signature = [configuration.enabled, configuration.apiRoot, configuration.stubLoginCode].join('|')
  if (!singleton || signature !== singletonSignature) { singleton = createBackendApi({ configuration }); singletonSignature = signature }
  return singleton
}

module.exports = {
  createBackendApi,
  available:() => active().available(),
  isAuthenticated:() => active().isAuthenticated(),
  currentUser:() => active().currentUser(),
  currentSession:() => active().currentSession(),
  progressSyncAvailable:() => active().progressSyncAvailable(),
  savedWordSyncAvailable:() => active().savedWordSyncAvailable(),
  loginWechat:() => active().loginWechat(),
  getMe:() => active().getMe(),
  logout:() => active().logout(),
  listWorks:(cursor, limit) => active().listWorks(cursor, limit),
  getWork:workId => active().getWork(workId),
  getManifest:(pieceId, version) => active().getManifest(pieceId, version),
  submitQuiz:attempt => active().submitQuiz(attempt),
  localImport:request => active().localImport(request),
  putProgress:(pieceId, request) => active().putProgress(pieceId, request),
  getProgress:pieceId => active().getProgress(pieceId),
  listProgress:(cursor, limit) => active().listProgress(cursor, limit),
  savedWordSync:request => active().savedWordSync(request),
  rankingOptions:() => active().rankingOptions(),
  rankings:filters => active().rankings(filters),
  rankingDetail:(participantId, filters) => active().rankingDetail(participantId, filters)
}
