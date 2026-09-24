const ERROR_KINDS = Object.freeze({
  DISABLED: 'disabled',
  INVALID_CONFIG: 'invalid_config',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  CANCELLED: 'cancelled',
  HTTP: 'http',
  UNAUTHORIZED: 'unauthorized',
  CONTRACT: 'contract',
  SERVER: 'server'
})

const SAFE_MESSAGES = Object.freeze({
  [ERROR_KINDS.DISABLED]: '服务连接尚未启用',
  [ERROR_KINDS.INVALID_CONFIG]: '服务配置不可用',
  [ERROR_KINDS.TIMEOUT]: '连接超时，请稍后重试',
  [ERROR_KINDS.NETWORK]: '网络连接失败，请检查网络',
  [ERROR_KINDS.CANCELLED]: '请求已取消',
  [ERROR_KINDS.HTTP]: '服务暂时不可用，请稍后重试',
  [ERROR_KINDS.UNAUTHORIZED]: '登录状态已失效，请重新登录',
  [ERROR_KINDS.CONTRACT]: '服务响应格式异常',
  [ERROR_KINDS.SERVER]: '服务暂时不可用，请稍后重试'
})

class ApiClientError extends Error {
  constructor(kind, options = {}) {
    super(options.message || SAFE_MESSAGES[kind] || SAFE_MESSAGES.server)
    this.name = 'ApiClientError'
    this.kind = kind
    this.statusCode = options.statusCode == null ? null : Number(options.statusCode)
    this.serverCode = options.serverCode || null
    this.requestId = options.requestId || null
    this.retryable = !!options.retryable
    if (options.cause !== undefined) this.cause = options.cause
  }
}

function toUserMessage(error) {
  return SAFE_MESSAGES[error && error.kind] || SAFE_MESSAGES.server
}

module.exports = { ERROR_KINDS, SAFE_MESSAGES, ApiClientError, toUserMessage }
