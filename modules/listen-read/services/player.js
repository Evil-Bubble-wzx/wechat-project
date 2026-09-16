// Foreground demo player. Production background audio can replace this adapter.
function createPlayer(options) {
  const audio = wx.createInnerAudioContext()
  let disposed = false
  let playing = false
  let started = false
  let pendingSeek = Math.max(0, options.start || 0)
  let lastClock = 0
  let listened = 0
  let lastTime = pendingSeek
  audio.obeyMuteSwitch = false
  function tick() {
    if (disposed) return
    const now = Date.now()
    if (playing && lastClock && audio.currentTime > lastTime) listened += Math.min((now - lastClock) / 1000, 1)
    lastClock = now
    lastTime = audio.currentTime || 0
    options.onTime(lastTime)
  }
  audio.onTimeUpdate(tick)
  audio.onPlay(() => {
    started = true; playing = true; lastClock = Date.now()
    options.onState('playing')
    if (pendingSeek > 0) { const target = pendingSeek; pendingSeek = 0; audio.seek(target) }
  })
  audio.onPause(() => { playing = false; lastClock = 0; options.onState('paused') })
  audio.onStop(() => { playing = false; lastClock = 0; options.onState('paused') })
  audio.onWaiting(() => { lastClock = 0; options.onState('loading') })
  audio.onCanplay(() => { if (!playing) options.onState('paused') })
  audio.onEnded(() => { playing = false; options.onTime(options.duration); options.onState('ended'); options.onEnded() })
  audio.onError(error => { playing = false; lastClock = 0; options.onState('error'); options.onError(error) })
  audio.src = options.src
  return {
    play() { if (!disposed) audio.play() },
    pause() { if (!disposed) audio.pause() },
    seek(seconds) {
      const value = Math.max(0, Math.min(seconds, options.duration - 0.02))
      lastTime = value; lastClock = Date.now()
      if (!started) pendingSeek = value
      else audio.seek(value)
      options.onTime(value)
    },
    rate(value) { audio.playbackRate = value },
    takeListened() { const value = listened; listened = 0; return value },
    destroy() { if (disposed) return; disposed = true; audio.destroy() }
  }
}
module.exports = { createPlayer }
