const productMode = require('./config/product-mode')
const savedWordSync = require('./modules/sync/saved-word-sync')
const librarySync = require('./modules/sync/library-sync')
const quizSync = require('./modules/sync/quiz-sync')

App({
  globalData: { mode: productMode.resolveMode() },
  onLaunch() { if(!productMode.current().isDemo){savedWordSync.start();librarySync.start();quizSync.start()} },
  onShow() { if(!productMode.current().isDemo){savedWordSync.foreground();librarySync.foreground();quizSync.foreground()} }
})
