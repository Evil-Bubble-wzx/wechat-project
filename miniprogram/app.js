const productMode = require('./config/product-mode')
const progressSync = require('./modules/sync/progress-sync')
const savedWordSync = require('./modules/sync/saved-word-sync')

App({
  globalData: { mode: productMode.resolveMode() },
  onLaunch() { progressSync.start();savedWordSync.start() },
  onShow() { progressSync.foreground();savedWordSync.foreground() }
})
