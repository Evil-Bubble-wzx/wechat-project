const DEV_API_BASE_URL_KEY = 'tingyue.dev.apiBaseUrl'
const DEV_STUB_LOGIN_CODE_KEY = 'tingyue.dev.stubLoginCode'

function envVersion() {
  try { return wx.getAccountInfoSync?.().miniProgram?.envVersion || 'develop' } catch (_) { return 'develop' }
}

function extConfig() {
  try { return wx.getExtConfigSync?.() || {} } catch (_) { return {} }
}

function current() {
  const env = envVersion()
  const ext = extConfig()
  const development = env === 'develop'
  let baseUrl = String(ext.apiBaseUrl || '').replace(/\/+$/,'')
  let stubLoginCode = null
  if (development) {
    try { baseUrl = String(wx.getStorageSync(DEV_API_BASE_URL_KEY) || baseUrl || 'http://127.0.0.1:3100').replace(/\/+$/,'') } catch (_) {}
    try { stubLoginCode = String(wx.getStorageSync(DEV_STUB_LOGIN_CODE_KEY) || 'test:miniapp-develop') } catch (_) { stubLoginCode = 'test:miniapp-develop' }
  }
  return { envVersion:env, development, baseUrl, stubLoginCode, contractVersion:'api-contract-v1.0.0' }
}

function setDevelopmentBaseUrl(baseUrl) {
  const value=String(baseUrl||'').replace(/\/+$/,'')
  if(!/^https?:\/\//.test(value))throw new Error('API base URL must use http or https')
  wx.setStorageSync(DEV_API_BASE_URL_KEY,value)
}

module.exports={DEV_API_BASE_URL_KEY,DEV_STUB_LOGIN_CODE_KEY,current,setDevelopmentBaseUrl}
