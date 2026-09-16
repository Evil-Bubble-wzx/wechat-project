const store = require('../../services/store')
Page({
  data: { logged: false, simulated: false, count: 0 },
  onShow() { const s = store.read(); this.setData({ logged: !!s.auth, simulated: !!s.friendSimulated, count: s.coupons.filter(c => !c.used && c.expires > Date.now()).length }) },
  login() { wx.navigateTo({ url: '/modules/listen-read/pages/login/index' }) },
  simulate() { if (store.simulateFriendLogin()) { this.onShow(); wx.showToast({ title: '双方奖励演示已触发', icon: 'none' }) } },
  coupons() { wx.navigateTo({ url: '/modules/listen-read/pages/coupons/index' }) },
  onShareAppMessage() { return { title: '和我一起听英语故事，免费体验第一章', path: '/modules/listen-read/pages/home/index?invite=demo' } }
})
