const PRODUCTION = 'production'
const DEMO = 'demo'
const DEV_MODE_KEY = 'tingyue.dev.mode'
const PRODUCT_STORAGE_KEY = 'tingyue.product.v1'
const DEMO_STORAGE_KEY = 'tingyue.demo.v1'

const productionRoutes = ['home','library','me','detail','player','recent','report','ranking','login','quiz']
const demoRoutes = [...productionRoutes,'loans','coupons','invite']
const productionBookIds = ['peter']

function resolveMode() {
  if (typeof wx === 'undefined') return PRODUCTION
  if (wx.isBrowserPreview) return wx.__tingyueMode === DEMO ? DEMO : PRODUCTION
  try {
    const envVersion = wx.getAccountInfoSync?.().miniProgram?.envVersion
    if (envVersion === 'develop' && wx.getStorageSync(DEV_MODE_KEY) === DEMO) return DEMO
  } catch (_) {}
  return PRODUCTION
}

function current() {
  const mode = resolveMode()
  const isDemo = mode === DEMO
  const allowedRoutes = isDemo ? demoRoutes : productionRoutes
  return {
    mode,
    isDemo,
    storageKey:isDemo ? DEMO_STORAGE_KEY : PRODUCT_STORAGE_KEY,
    allowedRoutes,
    allowedBookIds:isDemo ? null : productionBookIds,
    allowsRoute(route) { return allowedRoutes.includes(route) },
    allowsBook(bookId) { return isDemo || productionBookIds.includes(bookId) }
  }
}

module.exports = { PRODUCTION, DEMO, DEV_MODE_KEY, PRODUCT_STORAGE_KEY, DEMO_STORAGE_KEY, productionRoutes, productionBookIds, resolveMode, current }

