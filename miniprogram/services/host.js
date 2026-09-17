// Replace this adapter when embedding in another mini program.
const key = 'tingyue.demo.v1'
module.exports = {
  read() { try { return wx.getStorageSync(key) || {} } catch (_) { return {} } },
  write(state) { wx.setStorageSync(key, state) },
  toast(title) { wx.showToast({ title, icon:'none', duration:2200 }) },
  go(page, id) {
    const url = '/pages/' + page + '/index' + (id ? '?id=' + encodeURIComponent(id) : '')
    if (['home','recent','me'].includes(page)) wx.switchTab({ url })
    else wx.navigateTo({ url })
  },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.switchTab({ url:'/pages/home/index' }) },
  inset() { try { return wx.getWindowInfo().statusBarHeight || 24 } catch (_) { return 24 } }
}
