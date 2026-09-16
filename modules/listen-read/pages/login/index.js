const store = require('../../services/store')
Page({
  data: { phone: '', code: '', notice: '' },
  phone(e) { this.setData({ phone: e.detail.value }) },
  code(e) { this.setData({ code: e.detail.value }) },
  wechat() { if (store.login('wechat')) { wx.showToast({ title: '体验登录成功' }); wx.navigateBack() } },
  mobile() {
    if (!/^1\d{10}$/.test(this.data.phone) || this.data.code !== '123456') { this.setData({ notice: '请输入 11 位手机号和演示验证码 123456' }); return }
    if (store.login('phone', this.data.phone)) { wx.showToast({ title: '体验登录成功' }); wx.navigateBack() }
  }
})
