const content = require('../../services/content')
const store = require('../../services/store')
const playback = require('../../services/player')
Page({
  data: { ready: false, index: 0, selected: -1, checked: false, correct: 0, done: false, question: null, options: [], total: 0, percent: 0, results: [], score: 0 },
  onLoad(options) {
    const ch = content.getChapter(options.book, options.piece)
    if (!ch) { wx.showToast({ title: '题目暂未找到', icon: 'none' }); return }
    if (!content.canRead(options.book, options.piece)) { wx.redirectTo({ url: '/modules/listen-read/pages/book/index?id=' + options.book }); return }
    this.bookId = options.book; this.pieceId = options.piece; this.questions = ch.quiz
    this.setData({ ready: true, chapterTitle: ch.zh, total: ch.quiz.length })
    this.renderQuestion()
  },
  renderQuestion() {
    if (this.optionAudio) this.optionAudio.stop()
    const q = this.questions[this.data.index]
    this.setData({ question: q, selected: -1, checked: false, percent: this.data.index / this.questions.length * 100, options: q.options.map((text, i) => ({ text, index: i, letter: ['A','B','C','D'][i], audio: '/assets/quiz-audio/' + this.pieceId + '-' + this.data.index + '-' + i + '.wav' })) })
  },
  select(e) { if (!this.data.checked) this.setData({ selected: Number(e.currentTarget.dataset.index) }) },
  playOption(e) {
    playback.pause()
    if (!this.optionAudio) this.optionAudio = wx.createInnerAudioContext()
    this.optionAudio.stop()
    this.optionAudio.src = this.data.options[Number(e.currentTarget.dataset.index)].audio
    this.optionAudio.play()
  },
  onUnload() { if (this.optionAudio) this.optionAudio.destroy() },
  submit() {
    if (this.data.selected < 0 || this.data.checked) return
    const q = this.data.question, right = this.data.selected === q.answer
    const results = this.data.results.concat([{ q: q.q, zh: q.zh, selected: q.options[this.data.selected], answer: q.options[q.answer], right, explanation: q.explanation }])
    this.setData({ checked: true, correct: this.data.correct + (right ? 1 : 0), results })
  },
  next() {
    if (this.data.index + 1 === this.questions.length) {
      store.score(this.pieceId, this.data.correct, this.questions.length)
      this.setData({ done: true, score: Math.round(this.data.correct / this.questions.length * 100), percent: 100 })
    } else { this.setData({ index: this.data.index + 1 }); this.renderQuestion() }
  },
  retry() { this.setData({ index: 0, correct: 0, done: false, results: [] }); this.renderQuestion() },
  listen() { wx.redirectTo({ url: '/modules/listen-read/pages/reader/index?book=' + this.bookId + '&piece=' + this.pieceId }) },
  home() { wx.switchTab({ url: '/modules/listen-read/pages/home/index' }) }
})
