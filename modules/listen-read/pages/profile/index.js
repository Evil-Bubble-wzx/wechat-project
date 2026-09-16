const store = require('../../services/store')
Page({
  data: { stats: {}, duration: '0 秒', report: false, aboutOpen: false, auth: null, couponCount: 0 },
  onShow() { const stats = store.stats(), s = store.read(); this.setData({ stats, auth: s.auth, couponCount: s.coupons.filter(c => !c.used && c.expires > Date.now()).length, duration: stats.seconds < 60 ? stats.seconds + ' 秒' : Math.floor(stats.seconds / 60) + ' 分 ' + stats.seconds % 60 + ' 秒' }) },
  shelf() { wx.switchTab({ url: '/modules/listen-read/pages/shelf/index' }) },
  words() { wx.navigateTo({ url: '/modules/listen-read/pages/vocab/index' }) },
  login() { wx.navigateTo({ url: '/modules/listen-read/pages/login/index' }) },
  invite() { wx.navigateTo({ url: '/modules/listen-read/pages/invite/index' }) },
  coupons() { wx.navigateTo({ url: '/modules/listen-read/pages/coupons/index' }) },
  logout() { store.logout(); this.onShow() },
  report() { this.setData({ report: !this.data.report }) },
  about() { this.setData({ aboutOpen: true }) },
  closeAbout() { this.setData({ aboutOpen: false }) },
  noop() {}
})
