// Shared playback survives page navigation. Hosted HTTPS audio uses WeChat background mode.
let session = null
const listeners = []
function snapshot() { return session ? { src: session.src, bookId: session.bookId, pieceId: session.pieceId, title: session.title, position: session.position, duration: session.duration, state: session.state, background: session.background } : null }
function notify() { listeners.slice().forEach(fn => fn(snapshot())) }
function subscribe(fn) { listeners.push(fn); fn(snapshot()); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } }
function open(options) {
  if (session && session.src === options.src) return session.api
  if (session) session.api.destroy()
  const background = /^https:\/\//.test(options.src) && typeof wx.getBackgroundAudioManager === 'function'
  const audio = background ? wx.getBackgroundAudioManager() : wx.createInnerAudioContext()
  const current = { src: options.src, bookId: options.bookId, pieceId: options.pieceId, title: options.title, duration: options.duration, position: Math.max(0, options.start || 0), state: 'paused', background, listened: 0, lastClock: 0, pendingSeek: Math.max(0, options.start || 0), started: false, disposed: false, api: null }
  session = current
  if (!background) audio.obeyMuteSwitch = false
  function state(value) { if (current.disposed) return; current.state = value; if (value !== 'playing') current.lastClock = 0; notify() }
  function tick() {
    if (current.disposed) return
    const now = Date.now(), position = audio.currentTime || 0
    if (current.state === 'playing' && current.lastClock && position > current.position) current.listened += Math.min((now - current.lastClock) / 1000, 1)
    current.lastClock = now; current.position = position; notify()
  }
  audio.onTimeUpdate(tick)
  audio.onPlay(() => { current.started = true; current.lastClock = Date.now(); state('playing'); if (current.pendingSeek > 0) { const p = current.pendingSeek; current.pendingSeek = 0; audio.seek(p) } })
  audio.onPause(() => state('paused'))
  audio.onStop(() => state('paused'))
  audio.onWaiting(() => state('loading'))
  audio.onEnded(() => { current.position = current.duration; state('ended') })
  audio.onError(() => state('error'))
  if (background) { audio.title = options.title || '芽芽听阅'; audio.epname = '芽芽听阅'; audio.singer = '芽芽听阅' }
  audio.src = options.src
  current.api = {
    play() { if (!current.disposed) audio.play() },
    pause() { if (!current.disposed) audio.pause() },
    seek(seconds) { const value = Math.max(0, Math.min(seconds, current.duration - .02)); current.position = value; if (!current.started) current.pendingSeek = value; else audio.seek(value); notify() },
    rate(value) { if (!background) audio.playbackRate = value },
    takeListened() { const value = current.listened; current.listened = 0; return value },
    destroy() { if (current.disposed) return; current.disposed = true; audio.stop(); if (!background) audio.destroy(); if (session === current) { session = null; notify() } }
  }
  notify()
  return current.api
}
function toggle() { const s = snapshot(); if (!s) return; if (s.state === 'playing' || s.state === 'loading') session.api.pause(); else session.api.play() }
function pause() { if (session) session.api.pause() }
module.exports = { open, snapshot, subscribe, toggle, pause }
