function createWxTransport(wxApi) {
  const runtime = wxApi || (typeof wx !== 'undefined' ? wx : null)
  if (!runtime || typeof runtime.request !== 'function') throw new Error('wx.request is unavailable')

  return function wxTransport(request) {
    return new Promise((resolve, reject) => {
      let settled = false
      let task = null
      const signal = request.signal
      const finish = callback => value => {
        if (settled) return
        settled = true
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abort)
        callback(value)
      }
      const abort = () => {
        finish(reject)(Object.assign(new Error('Request cancelled'), { code: 'ERR_CANCELLED' }))
        if (task && typeof task.abort === 'function') task.abort()
      }
      if (signal && signal.aborted) return abort()
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', abort, { once: true })
      task = runtime.request({
        url: request.url,
        method: request.method,
        header: request.headers,
        data: request.body,
        timeout: request.timeoutMs,
        success: finish(resolve),
        fail: finish(reject)
      })
    })
  }
}

module.exports = { createWxTransport }
