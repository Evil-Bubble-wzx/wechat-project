const content = require('../../services/content')
const store = require('../../services/store')
Page({
  data: { tab: 'reading', books: [], count: 0 },
  onShow() { this.refresh() },
  choose(e) { this.setData({ tab: e.currentTarget.dataset.tab }); this.refresh() },
  refresh() {
    const s = store.read(), all = content.listBooks()
    const ids = Object.keys(s.progress).map(k => s.progress[k].bookId)
    this.setData({ count: s.purchased.length, books: all.filter(b => this.data.tab === 'owned' ? b.owned : ids.indexOf(b.id) !== -1) })
  },
  openBook(e) { wx.navigateTo({ url: '/modules/listen-read/pages/book/index?id=' + e.detail.id }) },
  discover() { wx.switchTab({ url: '/modules/listen-read/pages/home/index' }) }
})
