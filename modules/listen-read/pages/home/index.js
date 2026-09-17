const content = require('../../services/content')
const store = require('../../services/store')
Page({
  data: { filter: '全部', filters: ['全部', 'L1 启蒙', 'L2 进阶'], search: '', books: [], last: null },
  onShow() { this.refresh() },
  refresh() {
    const books = content.listBooks(), state = store.read()
    let last = null
    if (state.last) {
      const book = content.getBook(state.last.bookId), ch = content.getChapter(state.last.bookId, state.last.pieceId)
      const p = state.progress[state.last.pieceId]
      if (book && ch && p) last = { bookId: book.id, pieceId: ch.id, cover: book.cover, title: book.zh, chapter: ch.zh, percent: Math.min(100, Math.round(p.seconds / p.duration * 100)), completed: p.completed }
    }
    this.allBooks = books
    this.setData({ last })
    this.applyFilter()
  },
  applyFilter() {
    const query = this.data.search.trim().toLowerCase(), filter = this.data.filter
    this.setData({ books: this.allBooks.filter(b => (filter === '全部' || b.level === filter.slice(0,2)) && (b.title + b.zh + b.theme).toLowerCase().indexOf(query) !== -1) })
  },
  filter(e) { this.setData({ filter: e.currentTarget.dataset.value }); this.applyFilter() },
  search(e) { this.setData({ search: e.detail.value }); this.applyFilter() },
  openBook(e) { const id = e.detail.id || e.currentTarget.dataset.id; wx.navigateTo({ url: '/modules/listen-read/pages/book/index?id=' + id }) },
  start() { wx.navigateTo({ url: '/modules/listen-read/pages/reader/index?book=little-seed&piece=seed-1' }) },
  resume() { const l = this.data.last; wx.navigateTo({ url: '/modules/listen-read/pages/reader/index?book=' + l.bookId + '&piece=' + l.pieceId }) },
  toShelf() { wx.switchTab({ url: '/modules/listen-read/pages/shelf/index' }) },
  toWords() { wx.navigateTo({ url: '/modules/listen-read/pages/vocab/index' }) },
  toQuiz() {
    const l = store.read().last || { bookId: 'little-seed', pieceId: 'seed-1' }
    const chapter = content.getChapter(l.bookId, l.pieceId)
    const target = chapter && chapter.quiz.length ? l : { bookId: 'little-seed', pieceId: 'seed-1' }
    wx.navigateTo({ url: '/modules/listen-read/pages/quiz/index?book=' + target.bookId + '&piece=' + target.pieceId })
  }
})
