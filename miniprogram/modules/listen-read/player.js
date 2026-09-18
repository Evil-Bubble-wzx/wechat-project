// HTTPS recordings use background audio; bundled legacy clips use inner audio
// in the native mini program and the browser audio bridge in local preview.
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

function bindInner(ctx) {
  ctx.onTimeUpdate(function () { if (ctx === context && tickFn) tickFn(ctx.currentTime, ctx.duration) })
  ctx.onEnded(function () { if (ctx === context && endFn) endFn() })
  ctx.onError(function (err) { if (ctx === context && errorFn) errorFn(err) })
}

function createContext(nextMode) {
  const ctx = nextMode === 'inner' ? wx.createInnerAudioContext() : wx.getBackgroundAudioManager()
  if (nextMode === 'inner') bindInner(ctx)
  else bindBackground(ctx)
  return ctx
}

module.exports = {
  play(book, onTick, onEnd, onError) {
    if (!book.audioUrl && !book.localAudio) return false
    const nextMode = book.localAudio && !wx.isBrowserPreview ? 'inner' : 'background'
    if (context && mode !== nextMode) {
      try { context.stop() } catch (_) {}
      if (mode === 'inner') {
        try { context.destroy() } catch (_) {}
      }
      context = null
    }
    if (!context) context = createContext(nextMode)
    mode = nextMode
    tickFn = onTick
    endFn = onEnd
    errorFn = onError
    if (mode === 'background') {
      context.title = book.title
      context.singer = book.narrator || book.author
      if (book.coverUrl) context.coverImgUrl = book.coverUrl
    }
    const source = book.localAudio || (wx.isBrowserPreview && book.previewAudioUrl ? book.previewAudioUrl : book.audioUrl)
    if (context.src === source) {
      try { context.play() } catch (err) { if (errorFn) errorFn(err) }
    } else {
      context.src = source
      // BackgroundAudioManager auto-plays on src assignment (same for the
      // browser preview bridge); inner contexts need an explicit play().
      if (mode === 'inner') {
        try { context.play() } catch (err) { if (errorFn) errorFn(err) }
      }
    }
    return true
  },
  pause() { if (context) context.pause() },
  resume() { if (context) context.play() },
  seek(seconds) { if (context) context.seek(seconds) },
  rate(value) { if (context) context.playbackRate = value }
}
