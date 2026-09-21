// Replace this adapter when embedding in another mini program.
const productMode = require('../config/product-mode')
const learningFields = ['favorites','recent','progress','results','listeningSec','listenDaily','words']
function productState(state) {
  return learningFields.reduce((out,key) => {
    if (state[key] !== undefined) out[key] = state[key]
    return out
  }, {})
}
module.exports = {
  policy() { return productMode.current() },
  read() { try { const policy=productMode.current();const state=wx.getStorageSync(policy.storageKey)||{};return policy.isDemo?state:productState(state) } catch (_) { return {} } },
  write(state) { const policy=productMode.current();wx.setStorageSync(policy.storageKey,policy.isDemo?state:productState(state)) },
  toast(title) { wx.showToast({ title, icon:'none', duration:2200 }) },
  go(page, id) {
    const policy=productMode.current()
    const bookId=String(id||'').split(':')[0]
    if(!policy.allowsRoute(page)||bookId&&!policy.allowsBook(bookId)){this.toast('该内容尚未在正式模式开放');page='home';id=''}
    const route = page === 'quiz' && !wx.isBrowserPreview ? '/quiz/pages/index' : '/pages/' + page + '/index'
    const url = route + (id ? '?id=' + encodeURIComponent(id) : '')
    if (['home','recent','me'].includes(page)) wx.switchTab({ url })
    else wx.navigateTo({ url })
  },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.switchTab({ url:'/pages/home/index' }) },
  inset() { try { return wx.getWindowInfo().statusBarHeight || 24 } catch (_) { return 24 } }
}
