const { ERROR_KINDS, ApiClientError } = require('./errors')
const { createMemoryTokenStore } = require('./token-store')

const RETRYABLE_STATUS = new Set([502, 503, 504])
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD'])

function createApiClient(options = {}) {
  const enabled = options.enabled === true
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const transport = options.transport
  const tokenStore = options.tokenStore || createMemoryTokenStore()
  const refreshSession = options.refreshSession
  const timeoutMs = positiveNumber(options.timeoutMs, 10000)
  const maxRetries = nonNegativeInteger(options.maxRetries, 2)
  const sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)))
  const random = options.random || Math.random
  let refreshInFlight = null
  let sessionEpoch = 0

  async function request(input = {}) {
    assertReady(enabled, baseUrl, transport)
    const method = String(input.method || 'GET').toUpperCase()
    const path = normalizePath(input.path)
    const canRetry = IDEMPOTENT_METHODS.has(method)
    const retryLimit = canRetry ? nonNegativeInteger(input.maxRetries, maxRetries) : 0
    const requestTimeout = positiveNumber(input.timeoutMs, timeoutMs)
    let retries = 0
    let refreshed = false

    while (true) {
      try {
        const response = await runAttempt({
          transport,
          url: baseUrl + path,
          method,
          headers: buildHeaders(input.headers, tokenStore.getAccessToken()),
          body: input.body,
          timeoutMs: requestTimeout,
          signal: input.signal
        })
        const parsed = parseResponse(response)
        if (parsed.statusCode === 401) {
          if (!refreshed && typeof refreshSession === 'function') {
            refreshed = true
            await refreshAccessToken()
            continue
          }
          throw responseError(parsed)
        }
        if (parsed.statusCode < 200 || parsed.statusCode >= 300) throw responseError(parsed)
        return { data: parsed.data, requestId: parsed.requestId, statusCode: parsed.statusCode }
      } catch (error) {
        const normalized = normalizeError(error)
        if (!canRetry || retries >= retryLimit || !normalized.retryable) throw normalized
        await sleep(backoffDelay(retries++, random))
      }
    }
  }

  async function refreshAccessToken() {
    if (!refreshInFlight) {
      const refreshEpoch = sessionEpoch
      refreshInFlight = Promise.resolve()
        .then(() => refreshSession())
        .then(result => {
          if (refreshEpoch !== sessionEpoch) throw cancelledError()
          const token = typeof result === 'string' ? result : result && result.accessToken
          if (!token) throw new ApiClientError(ERROR_KINDS.CONTRACT)
          tokenStore.setAccessToken(token)
          return token
        })
        .catch(error => {
          tokenStore.clear()
          const normalized = normalizeError(error)
          normalized.retryable = false
          throw normalized
        })
        .finally(() => { refreshInFlight = null })
    }
    return refreshInFlight
  }

  function logout() {
    sessionEpoch += 1
    tokenStore.clear()
  }

  return { request, logout, tokenStore }
}

function assertReady(enabled, baseUrl, transport) {
  if (!enabled) throw new ApiClientError(ERROR_KINDS.DISABLED)
  if (!baseUrl || typeof transport !== 'function') throw new ApiClientError(ERROR_KINDS.INVALID_CONFIG)
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const url = value.trim().replace(/\/+$/, '')
  if (/^https:\/\//i.test(url)) return url
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) return url
  return null
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    throw new ApiClientError(ERROR_KINDS.INVALID_CONFIG)
  }
  return value
}

function buildHeaders(input, accessToken) {
  const headers = Object.assign({ Accept: 'application/json' }, input || {})
  if (accessToken) headers.Authorization = 'Bearer ' + accessToken
  return headers
}

async function runAttempt(request) {
  if (request.signal && request.signal.aborted) throw cancelledError()
  let timer = null
  let abortListener = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ApiClientError(ERROR_KINDS.TIMEOUT, { retryable: true })), request.timeoutMs)
  })
  const cancelPromise = new Promise((_, reject) => {
    if (!request.signal || typeof request.signal.addEventListener !== 'function') return
    abortListener = () => reject(cancelledError())
    request.signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(() => request.transport(request)), timeoutPromise, cancelPromise])
  } catch (error) {
    if (request.signal && request.signal.aborted) throw cancelledError(error)
    throw error
  } finally {
    clearTimeout(timer)
    if (abortListener && request.signal && typeof request.signal.removeEventListener === 'function') {
      request.signal.removeEventListener('abort', abortListener)
    }
  }
}

function parseResponse(response) {
  if (!response || !Number.isInteger(Number(response.statusCode))) throw new ApiClientError(ERROR_KINDS.CONTRACT)
  const statusCode = Number(response.statusCode)
  const data = response.data
  const requestId = headerValue(response.header || response.headers, 'x-request-id') || (data && data.requestId) || null
  return { statusCode, data, requestId }
}

function responseError(response) {
  const serverError = response.data && response.data.error
  const serverCode = serverError && typeof serverError.code === 'string' ? serverError.code : null
  const kind = response.statusCode === 401
    ? ERROR_KINDS.UNAUTHORIZED
    : serverCode ? ERROR_KINDS.SERVER : ERROR_KINDS.HTTP
  return new ApiClientError(kind, {
    statusCode: response.statusCode,
    serverCode,
    requestId: response.requestId,
    retryable: RETRYABLE_STATUS.has(response.statusCode)
  })
}

function normalizeError(error) {
  if (error instanceof ApiClientError) return error
  const text = String(error && (error.errMsg || error.message) || '')
  if (error && error.code === 'ERR_CANCELLED' || /abort|cancel/i.test(text)) return cancelledError(error)
  return new ApiClientError(ERROR_KINDS.NETWORK, { cause: error, retryable: true })
}

function cancelledError(cause) {
  return new ApiClientError(ERROR_KINDS.CANCELLED, { cause, retryable: false })
}

function headerValue(headers, wanted) {
  if (!headers || typeof headers !== 'object') return null
  const key = Object.keys(headers).find(name => name.toLowerCase() === wanted)
  return key ? headers[key] : null
}

function backoffDelay(retryIndex, random) {
  const jitter = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * 100)
  return 200 * Math.pow(2, retryIndex) + jitter
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

module.exports = { createApiClient, normalizeBaseUrl, backoffDelay }
