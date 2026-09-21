const productMode = require('./config/product-mode')

App({ globalData: { mode: productMode.resolveMode() } })
