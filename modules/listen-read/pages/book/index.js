const content = require('../../services/content')
const store = require('../../services/store')
Page({
  data: { book: null, chapters: [], owned: false, purchaseOpen: false, coupon: null, finalPrice: 0 },
  onLoad(options) { this.bookId = options.id; if (!content.getBook(this.bookId)) { wx.showToast({ title: '这本书暂未找到', icon: 'none' }); return } this.refresh() },
  onShow() { if (this.bookId && content.getBook(this.bookId)) this.refresh() },
  refresh() {
    const book = content.listBooks().find(b => b.id === this.bookId), state = store.read(), owned = store.owns(this.bookId)
    const coupon = store.availableCoupon(book.price)
    this.setData({ book, owned, coupon, finalPrice: book.price - (coupon ? coupon.amount : 0), chapters: book.chapters.map((ch, i) => { const c = content.chapterData(book.id, ch.id); return { id: ch.id, title: ch.title, zh: ch.zh, number: '0' + (i+1), free: i === 0, locked: i > 0 && !owned, duration: content.time(c.duration), completed: !!(state.progress[ch.id] || {}).completed } }) })
  },
  openChapter(e) { const id = e.currentTarget.dataset.id; if (!content.canRead(this.bookId, id)) { this.setData({ purchaseOpen: true }); return } this.read(id) },
  read(id) { wx.navigateTo({ url: '/modules/listen-read/pages/reader/index?book=' + this.bookId + '&piece=' + id }) },
  trial() { this.read(this.data.book.chapters[0].id) },
  buy() { if (this.data.owned) { const s = store.read().last; this.read(s && s.bookId === this.bookId ? s.pieceId : this.data.book.chapters[0].id) } else this.setData({ purchaseOpen: true }) },
  closePurchase() { this.setData({ purchaseOpen: false }) },
  noop() {},
  confirmPurchase() {
    if (!store.read().auth) { this.setData({ purchaseOpen: false }); wx.navigateTo({ url: '/modules/listen-read/pages/login/index' }); return }
    if (store.unlock(this.bookId)) { if (this.data.coupon) store.useCoupon(this.data.coupon.id); this.setData({ purchaseOpen: false }); this.refresh(); wx.showToast({ title: '已模拟解锁整本', icon: 'success' }) }
  }
})
