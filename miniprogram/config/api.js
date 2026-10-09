const DEV_API_BASE_URL_KEY = 'tingyue.dev.apiBaseUrl'
const DEV_STUB_LOGIN_CODE_KEY = 'tingyue.dev.stubLoginCode'
const CONTRACT_VERSION = 'api-contract-v2.0.0'

function current(runtime = typeof wx === 'undefined' ? null : wx) {
  const envVersion = readEnvVersion(runtime)
  const development = envVersion === 'develop'
  const ext = readExtConfig(runtime)
  let baseUrl = normalizeBaseUrl(ext.apiBaseUrl)
  let stubLoginCode = null
  if (development && runtime) {
    baseUrl = normalizeBaseUrl(readStorage(runtime, DEV_API_BASE_URL_KEY) || baseUrl || 'http://127.0.0.1:3100')
    stubLoginCode = String(readStorage(runtime, DEV_STUB_LOGIN_CODE_KEY) || 'test:miniapp-develop')
  }
  return {
    envVersion,
    development,
    baseUrl,
    apiRoot:baseUrl ? baseUrl + '/api/v1' : null,
    enabled:!!(runtime && !runtime.isBrowserPreview && typeof runtime.request === 'function' && baseUrl),
    stubLoginCode,
    contractVersion:CONTRACT_VERSION
  }
}

function setDevelopmentBaseUrl(baseUrl, runtime = typeof wx === 'undefined' ? null : wx) {
  if (!runtime || readEnvVersion(runtime) !== 'develop') throw new Error('Development API settings are unavailable')
  const value = normalizeBaseUrl(baseUrl)
  if (!value) throw new Error('API base URL must use HTTPS or local HTTP')
  runtime.setStorageSync(DEV_API_BASE_URL_KEY, value)
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '')
  if (/^https:\/\/[^/]+/i.test(text)) return text
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(text)) return text
  return null
}

function readEnvVersion(runtime) {
  try { return runtime && runtime.getAccountInfoSync && runtime.getAccountInfoSync().miniProgram.envVersion || 'develop' } catch (_) { return 'develop' }
}
function readExtConfig(runtime) { try { return runtime && runtime.getExtConfigSync ? runtime.getExtConfigSync() || {} : {} } catch (_) { return {} } }
function readStorage(runtime, key) { try { return runtime.getStorageSync(key) || '' } catch (_) { return '' } }

module.exports = { DEV_API_BASE_URL_KEY, DEV_STUB_LOGIN_CODE_KEY, CONTRACT_VERSION, current, setDevelopmentBaseUrl, normalizeBaseUrl }
