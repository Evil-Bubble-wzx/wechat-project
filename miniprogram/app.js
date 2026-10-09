const productMode = require('./config/product-mode')
const savedWordSync = require('./modules/sync/saved-word-sync')

App({
  globalData: { mode: productMode.resolveMode() },
  onLaunch() { if(!productMode.current().isDemo)savedWordSync.start() },
  onShow() { if(!productMode.current().isDemo)savedWordSync.foreground() }
})
