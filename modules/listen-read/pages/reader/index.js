const content = require('../../services/content')
const store = require('../../services/store')
const playback = require('../../services/player')
Page({
  data: { book: null, chapter: null, current: -1, position: 0, percent: 0, time: '0:00', total: '0:00', state: 'paused', translation: false, word: null, saved: false, chapterOpen: false, chapters: [], rate: 1, ended: false, error: '', follow: true, scrollTo: '' },
  onLoad(options) {
    const book = content.getBook(options.book), chapter = content.chapterData(options.book, options.piece)
    if (!book || !chapter) { this.setData({ error: '没有找到这一章，请返回书库重新选择。' }); return }
    if (!content.canRead(book.id, chapter.id)) {
      wx.redirectTo({ url: '/modules/listen-read/pages/book/index?id=' + book.id }); return
    }
    this.bookId = book.id; this.pieceId = chapter.id
    this.lastSave = 0
    const saved = store.read().progress[chapter.id]
    const position = saved && !saved.completed ? Math.min(saved.seconds, chapter.duration - .1) : 0
    this.setData({ book, chapter, position, time: content.time(position), total: content.time(chapter.duration),
      chapters: book.chapters.map((ch, i) => ({ id: ch.id, title: ch.title, zh: ch.zh, number: i+1, locked: !content.canRead(book.id, ch.id) })) })
    this.initPlayer(position)
    this.sync(position)
  },
  initPlayer(position) {
    const chapter = this.data.chapter
    this.player = playback.open({ src: chapter.backgroundAudio || chapter.audio, duration: chapter.duration, start: position, bookId: this.bookId, pieceId: this.pieceId, title: this.data.book.zh + ' · ' + chapter.zh })
    this.unsubscribe = playback.subscribe(value => {
      if (!value || value.pieceId !== this.pieceId) return
      this.setData({ state: value.state, ended: value.state === 'ended', error: value.state === 'error' ? '音频暂时没有加载成功，请点重试。' : '' })
      this.sync(value.position)
      if (value.state === 'paused' || value.state === 'ended') this.persist()
    })
  },
  onHide() { this.persist() },
  onUnload() { if (this.player) this.persist(); if (this.unsubscribe) this.unsubscribe() },
  persist() {
    if (!this.player || !this.bookId) return
    store.progress(this.bookId, this.pieceId, this.data.position, this.data.chapter.duration, this.player.takeListened())
    this.lastSave = Date.now()
  },
  sync(seconds) {
    if (!this.data.chapter || this.seeking) return
    const ch = this.data.chapter, position = Math.max(0, Math.min(seconds, ch.duration))
    const index = ch.cues.findIndex(c => position >= c.start && position < c.end)
    const current = position >= ch.duration ? ch.cues.length - 1 : index
    const patch = { position, percent: position / ch.duration * 100, time: content.time(position) }
    if (current !== this.data.current) { patch.current = current; if (this.data.follow && current >= 0) patch.scrollTo = 'line-' + current }
    this.setData(patch)
    if (Date.now() - this.lastSave > 4000 && this.player) this.persist()
  },
  togglePlay() {
    if (!this.player) return
    if (this.data.state === 'playing' || this.data.state === 'loading') this.player.pause()
    else {
      if (this.data.ended || this.data.position >= this.data.chapter.duration - .05) { this.player.seek(0); this.setData({ ended: false }) }
      this.setData({ error: '' }); this.player.play()
    }
  },
  retry() { if (!this.data.chapter) return; if (this.player) { this.persist(); this.player.destroy() } if (this.unsubscribe) this.unsubscribe(); this.setData({ error: '', ended: false }); this.initPlayer(this.data.position); this.player.play() },
  seekingStart() { this.seeking = true },
  seek(e) { this.seeking = false; this.setData({ ended: false }); if (this.player) this.player.seek(Number(e.detail.value) / 100 * this.data.chapter.duration) },
  move(e) {
    const delta = Number(e.currentTarget.dataset.delta), target = Math.max(0, Math.min(this.data.chapter.cues.length - 1, Math.max(0, this.data.current) + delta))
    this.setData({ ended: false }); this.player.seek(this.data.chapter.cues[target].start)
  },
  toggleTranslation() { this.setData({ translation: !this.data.translation }) },
  toggleFollow() { const follow = !this.data.follow; this.setData({ follow, scrollTo: follow ? 'line-' + Math.max(0, this.data.current) : '' }) },
  rate() { const rates = [0.8, 1, 1.2], value = rates[(rates.indexOf(this.data.rate) + 1) % rates.length]; this.player.rate(value); this.setData({ rate: value }) },
  wordTap(e) {
    const { word, line } = e.currentTarget.dataset
    if (!word) return
    this.player.pause()
    const cue = this.data.chapter.cues[Number(line)], meaning = content.meaning(word)
    const detail = Object.assign({}, meaning, { surface: word, showLemma: meaning.lemma.toLowerCase() !== word.toLowerCase(), key: this.pieceId + ':' + line + ':' + word.toLowerCase(), sentence: cue.text, translation: cue.zh, bookId: this.bookId, pieceId: this.pieceId, bookTitle: this.data.book.zh })
    this.setData({ word: detail, saved: !!store.read().words[detail.key] })
  },
  closeWord() { this.setData({ word: null }) },
  toggleSave() {
    const saved = this.data.saved
    const ok = saved ? store.removeWord(this.data.word.key) : store.saveWord(this.data.word)
    if (ok) { this.setData({ saved: !saved }); wx.showToast({ title: saved ? '已移出生词本' : '已加入单词花园', icon: 'none' }) }
  },
  noop() {},
  openChapters() { this.player.pause(); this.setData({ chapterOpen: true }) },
  closeChapters() { this.setData({ chapterOpen: false }) },
  chooseChapter(e) {
    const id = e.currentTarget.dataset.id
    if (id === this.pieceId) { this.closeChapters(); return }
    this.persist()
    if (!content.canRead(this.bookId, id)) { wx.navigateTo({ url: '/modules/listen-read/pages/book/index?id=' + this.bookId }); return }
    wx.redirectTo({ url: '/modules/listen-read/pages/reader/index?book=' + this.bookId + '&piece=' + id })
  },
  quiz() { this.player.pause(); this.persist(); wx.navigateTo({ url: '/modules/listen-read/pages/quiz/index?book=' + this.bookId + '&piece=' + this.pieceId }) },
  home() { wx.switchTab({ url: '/modules/listen-read/pages/home/index' }) }
})
