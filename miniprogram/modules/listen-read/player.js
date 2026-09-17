// Native adapter; the browser bridge uses the downloaded recording for local tests.
let context
module.exports = {
  play(book, onTick, onEnd, onError) {
    if (!book.audioUrl) return false
    if (!context) context = wx.getBackgroundAudioManager()
    if (this.tick) context.offTimeUpdate(this.tick)
    if (this.end) context.offEnded(this.end)
    if (this.error) context.offError(this.error)
    this.tick = () => onTick(context.currentTime, context.duration)
    this.end = onEnd
    this.error = onError
    context.onTimeUpdate(this.tick); context.onEnded(this.end); context.onError(this.error)
    context.title = book.title; context.singer = book.narrator || book.author
    if (book.coverUrl) context.coverImgUrl = book.coverUrl
    const source = wx.isBrowserPreview && book.previewAudioUrl ? book.previewAudioUrl : book.audioUrl
    if (context.src === source) context.play()
    else context.src = source
    return true
  },
  pause() { if (context) context.pause() },
  resume() { if (context) context.play() },
  seek(seconds) { if (context) context.seek(seconds) },
  rate(value) { if (context) context.playbackRate = value }
}
