// Replace this adapter when embedding in another mini program.
const productMode = require('../config/product-mode')
const learningFields = ['favorites','recent','progress','results','listeningSec','listenDaily','words','idMigrationVersion','progressSchemaVersion']
const LEGACY_WORK_ID = 'peter'
const WORK_ID = 'peter-rabbit'
const PIECE_ID = 'peter-rabbit-01'
function migrateState(input, isDemo = false) {
  const state = Object.assign({}, input || {})
  state.progress = Object.assign({}, state.progress || {})
  if ((Number(state.idMigrationVersion)||0) < 1) {
    for (const key of ['favorites','recent','demoPurchases']) {
      if (Array.isArray(state[key])) state[key] = [...new Set(state[key].map(id => id === LEGACY_WORK_ID ? WORK_ID : id))]
    }
    if (state.progress[LEGACY_WORK_ID]) {
      const legacy = state.progress[LEGACY_WORK_ID]
      const current = state.progress[PIECE_ID]
      state.progress[PIECE_ID] = current ? Object.assign({},legacy,current,{
        seconds:Math.max(Number(current.seconds)||0,Number(legacy.seconds)||0),
        completed:!!(current.completed||legacy.completed)
      }) : legacy
      delete state.progress[LEGACY_WORK_ID]
    }
    state.listenDaily = Object.fromEntries(Object.entries(state.listenDaily || {}).map(([key,value]) => [key.endsWith(':'+LEGACY_WORK_ID) ? key.slice(0,-LEGACY_WORK_ID.length)+PIECE_ID : key,value]))
    state.results = (state.results || []).map(result => {
      const next = Object.assign({},result)
      if(next.bookId===LEGACY_WORK_ID)next.bookId=WORK_ID
      if(next.pieceId===LEGACY_WORK_ID||(!next.pieceId&&next.title==='The Tale of Peter Rabbit'))next.pieceId=PIECE_ID
      return next
    })
    state.idMigrationVersion=1
  }
  if ((Number(state.progressSchemaVersion)||0) < 2) {
    state.progress = Object.fromEntries(Object.entries(state.progress).map(([key,value]) => {
      const previous = Object.assign({}, value || {})
      if (isDemo) return [key,Object.assign(previous,{checkpointSeconds:Number(previous.seconds)||0,schemaVersion:2})]
      if (key === PIECE_ID) return [key,{seconds:0,checkpointSeconds:0,completed:false,listenedRanges:[],listenedSeconds:0,coverage:0,completionReason:null,schemaVersion:2}]
      return [key,previous]
    }))
    state.progressSchemaVersion = 2
  }
  return state
}
function productState(state) {
  return learningFields.reduce((out,key) => {
    if (state[key] !== undefined) out[key] = state[key]
    return out
  }, {})
}
module.exports = {
  policy() { return productMode.current() },
  read() { try { const policy=productMode.current();const state=migrateState(wx.getStorageSync(policy.storageKey)||{},policy.isDemo);wx.setStorageSync(policy.storageKey,policy.isDemo?state:productState(state));return policy.isDemo?state:productState(state) } catch (_) { return {} } },
  write(state) { const policy=productMode.current();const migrated=migrateState(state,policy.isDemo);wx.setStorageSync(policy.storageKey,policy.isDemo?migrated:productState(migrated)) },
  mutate(mutator) { const current=this.read();const next=mutator(current)||current;this.write(next);return next },
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
