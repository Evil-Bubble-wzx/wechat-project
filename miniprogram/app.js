const productMode = require('./config/product-mode')
const savedWordSync = require('./modules/sync/saved-word-sync')
const librarySync = require('./modules/sync/library-sync')
const quizSync = require('./modules/sync/quiz-sync')
const api = require('./services/api')
const progressSync = require('./modules/sync/progress-sync')
async function foreground(){
  const previousOwner=api.currentUser()?.userId
  const restored=await api.reconnectOffline()
  if(restored&&previousOwner!==api.currentUser()?.userId)require('./modules/listen-read/player').pause('account_changed')
  savedWordSync.foreground();librarySync.foreground();quizSync.foreground()
  if(restored){void progressSync.activate();const pages=typeof getCurrentPages==='function'?getCurrentPages():[];const page=pages[pages.length-1];page?.refresh?.();void page?.loadRemote?.()}
}

App({
  globalData: { mode: productMode.resolveMode() },
  onLaunch() { if(!productMode.current().isDemo){api.currentUser();savedWordSync.start();librarySync.start();quizSync.start();wx.onNetworkStatusChange?.(result=>{if(result.isConnected)void foreground()})} },
  onShow() { if(!productMode.current().isDemo)void foreground() }
})
