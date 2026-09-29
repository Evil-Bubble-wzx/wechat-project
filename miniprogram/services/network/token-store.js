function createMemoryTokenStore(initialAccessToken = null) {
  let accessToken = normalize(initialAccessToken)
  return {
    getAccessToken() { return accessToken },
    setAccessToken(value) { accessToken = normalize(value) },
    clear() { accessToken = null }
  }
}

function normalize(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

module.exports = { createMemoryTokenStore }
