const store = require('../../services/store')
Page({
  data: { stats: {}, duration: '0 秒', report: false, aboutOpen: false },
  onShow() { const stats = store.stats(); this.setData({ stats, duration: stats.seconds < 60 ? stats.seconds + ' 秒' : Math.floor(stats.seconds / 60) + ' 分 ' + stats.seconds % 60 + ' 秒' }) },
  shelf() { wx.switchTab({ url: '/modules/listen-read/pages/shelf/index' }) },
  words() { wx.navigateTo({ url: '/modules/listen-read/pages/vocab/index' }) },
  report() { this.setData({ report: !this.data.report }) },
  about() { this.setData({ aboutOpen: true }) },
  closeAbout() { this.setData({ aboutOpen: false }) },
  noop() {}
})
