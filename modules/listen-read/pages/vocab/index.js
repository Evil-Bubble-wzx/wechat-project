const store = require('../../services/store')
Page({
  data: { words: [], selected: null },
  onShow() { this.refresh() },
  refresh() { const s = store.read(); this.setData({ words: Object.keys(s.words).map(k => s.words[k]).reverse() }) },
  open(e) { this.setData({ selected: this.data.words.find(w => w.key === e.currentTarget.dataset.key) }) },
  close() { this.setData({ selected: null }) },
  noop() {},
  remove() { if (store.removeWord(this.data.selected.key)) { this.close(); this.refresh(); wx.showToast({ title: '已移出生词本', icon: 'none' }) } },
  listen() { const w = this.data.selected; wx.navigateTo({ url: '/modules/listen-read/pages/reader/index?book=' + w.bookId + '&piece=' + w.pieceId }) },
  discover() { wx.switchTab({ url: '/modules/listen-read/pages/home/index' }) }
})
