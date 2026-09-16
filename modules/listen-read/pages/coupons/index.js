const store = require('../../services/store')
Page({ data: { coupons: [] }, onShow() { this.setData({ coupons: store.read().coupons.map(c => ({ amount: c.amount, minimum: c.minimum, date: new Date(c.expires).toLocaleDateString(), status: c.used ? '已使用' : c.expires <= Date.now() ? '已过期' : '可使用' })) }) }, invite() { wx.navigateTo({ url: '/modules/listen-read/pages/invite/index' }) } })
