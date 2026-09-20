// All story recordings use the singleton background audio manager so playback
// can continue when the mini program moves to the background. Short quiz option
// recordings intentionally keep using InnerAudioContext in the page controller.
//
// NOTE: wx.getBackgroundAudioManager() is a singleton and (unlike
// wx.createInnerAudioContext()) provides no offTimeUpdate/offEnded/offError
// methods. Calling them throws `context.offTimeUpdate is not a function` in
// DevTools on the second play. Listeners are therefore bound once per context
// via stable dispatchers and never removed; per-play callbacks are swapped by
// assignment (the old demo11 player never called off* either).
let context
let mode
let tickFn
let endFn
let errorFn
let backgroundBound = false

function bindBackground(ctx) {
  if (backgroundBound) return
  ctx.onTimeUpdate(function () { if (mode === 'background' && tickFn) tickFn(ctx.currentTime, ctx.duration) })
  ctx.onEnded(function () { if (mode === 'background' && endFn) endFn() })
  ctx.onError(function (err) { if (mode === 'background' && errorFn) errorFn(err) })
  backgroundBound = true
}

function createContext() {
  const ctx = wx.getBackgroundAudioManager()
  bindBackground(ctx)
  return ctx
}

module.exports = {
  play(book, onTick, onEnd, onError) {
    if (!book.audioUrl && !book.localAudio) return false
    const nextMode = 'background'
    if (!context) context = createContext()
    mode = nextMode
    tickFn = onTick
    endFn = onEnd
    errorFn = onError
    if (mode === 'background') {
      context.title = book.title
      context.singer = book.narrator || book.author
      if (book.coverUrl || book.cover) context.coverImgUrl = book.coverUrl || book.cover
    }
    const source = book.localAudio || (wx.isBrowserPreview && book.previewAudioUrl ? book.previewAudioUrl : book.audioUrl)
    if (context.src === source) {
      try { context.play() } catch (err) { if (errorFn) errorFn(err) }
    } else {
      context.src = source
      // BackgroundAudioManager auto-plays on src assignment (same for the
      // browser preview bridge).
    }
    return true
  },
  pause() { if (context) context.pause() },
  resume() { if (context) context.play() },
  seek(seconds) { if (context) context.seek(seconds) },
  rate(value) { if (context) context.playbackRate = value }
}
