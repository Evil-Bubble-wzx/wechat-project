// HTTPS recordings use background audio; bundled legacy clips use inner audio
// in the native mini program and the browser audio bridge in local preview.
let context
let mode
let tick
let end
let error

function detach() {
  if (!context) return
  if (tick) context.offTimeUpdate(tick)
  if (end) context.offEnded(end)
  if (error) context.offError(error)
  tick = end = error = null
}

module.exports = {
  play(book, onTick, onEnd, onError) {
    if (!book.audioUrl && !book.localAudio) return false
    const nextMode = book.localAudio && !wx.isBrowserPreview ? 'inner' : 'background'
    if (context && mode !== nextMode) {
      detach()
      context.stop()
      if (mode === 'inner') context.destroy()
      context = null
    }
    if (!context) context = nextMode === 'inner' ? wx.createInnerAudioContext() : wx.getBackgroundAudioManager()
    mode = nextMode
    detach()
    tick = () => onTick(context.currentTime, context.duration)
    end = onEnd
    error = onError
    context.onTimeUpdate(tick)
    context.onEnded(end)
    context.onError(error)
    if (mode === 'background') {
      context.title = book.title
      context.singer = book.narrator || book.author
      if (book.coverUrl) context.coverImgUrl = book.coverUrl
    }
    const source = book.localAudio || (wx.isBrowserPreview && book.previewAudioUrl ? book.previewAudioUrl : book.audioUrl)
    if (context.src === source) context.play()
    else {
      context.src = source
      if (mode === 'inner') context.play()
    }
    return true
  },
  pause() { if (context) context.pause() },
  resume() { if (context) context.play() },
  seek(seconds) { if (context) context.seek(seconds) },
  rate(value) { if (context) context.playbackRate = value }
}
