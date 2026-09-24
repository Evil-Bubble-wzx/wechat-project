const { test } = require('node:test')
const assert = require('node:assert/strict')
const productMode = require('../miniprogram/config/product-mode')

test('production mode is the default and isolates demo state', () => {
  const previousWx = global.wx
  const stores = {
    [productMode.DEMO_STORAGE_KEY]: { user:{ id:'demo-reader' }, demoCoupons:[{ id:'coupon' }], demoPurchases:['little-seed'] },
    'tingyue.session.v1': { accessToken:'access-token', refreshToken:'refresh-token', user:{ id:'production-reader' } }
  }
  const navigation = []
  const toasts = []
  global.wx = {
    isBrowserPreview:true,
    __tingyueMode:'production',
    getStorageSync:key => stores[key],
    setStorageSync:(key,value) => { stores[key] = value },
    getWindowInfo:() => ({ statusBarHeight:24 }),
    showToast:({ title }) => toasts.push(title),
    switchTab:({ url }) => navigation.push(url),
    navigateTo:({ url }) => navigation.push(url)
  }
  try {
    const { createPage, getProductPolicy } = require('../miniprogram/ui/controller')
    assert.equal(getProductPolicy().mode, 'production')

    const home = createPage('home')
    home.setData = patch => Object.assign(home.data, patch)
    home.onLoad({})
    assert.deepEqual(home.data.books.map(book => book.id), ['peter-rabbit'])
    assert.equal(home.data.isDemo, false)

    const notices = createPage('notices')
    notices.setData = patch => Object.assign(notices.data, patch)
    notices.onLoad({})
    assert.equal(notices.data.route, 'notices')
    assert.ok(notices.data.contentNotices.length >= 5)

    const detail = createPage('detail')
    detail.setData = patch => Object.assign(detail.data, patch)
    detail.onLoad({ id:'little-seed' })
    assert.equal(detail.data.book.id, 'peter-rabbit')
    detail.toggleFavorite()
    assert.deepEqual(stores[productMode.PRODUCT_STORAGE_KEY].favorites, ['peter-rabbit'])
    assert.equal(stores[productMode.PRODUCT_STORAGE_KEY].user, undefined)
    assert.equal(stores[productMode.PRODUCT_STORAGE_KEY].demoCoupons, undefined)
    detail.openPurchase()
    assert.equal(detail.data.sheet, '')

    const login = createPage('login')
    login.setData = patch => Object.assign(login.data, patch)
    login.onLoad({})
    login.login()
    assert.equal(login.state.user, null)

    const blocked = createPage('coupons')
    blocked.setData = patch => Object.assign(blocked.data, patch)
    blocked.onLoad({})
    assert.equal(blocked.data.route, 'home')
    assert.ok(navigation.some(url => url.includes('/pages/home/index')))
    assert.ok(toasts.some(message => message.includes('开发演示模式')))
  } finally { global.wx = previousWx }
})

test('demo mode stays explicit and preserves the full catalog', () => {
  const previousWx = global.wx
  global.wx = {
    isBrowserPreview:true,
    __tingyueMode:'demo',
    getStorageSync:() => ({}),
    setStorageSync:() => {},
    getWindowInfo:() => ({ statusBarHeight:24 }),
    showToast:() => {}
  }
  try {
    const { createPage, getProductPolicy } = require('../miniprogram/ui/controller')
    assert.equal(getProductPolicy().mode, 'demo')
    assert.equal(getProductPolicy().allowsRoute('coupons'), true)
    const home = createPage('home')
    home.setData = patch => Object.assign(home.data, patch)
    home.onLoad({})
    assert.equal(home.data.books.length, 10)
    assert.equal(home.data.isDemo, true)
  } finally { global.wx = previousWx }
})

test('native Demo override only works in the WeChat develop environment', () => {
  const previousWx = global.wx
  let envVersion='release'
  global.wx = {
    getAccountInfoSync:() => ({ miniProgram:{ envVersion } }),
    getStorageSync:key => key===productMode.DEV_MODE_KEY?'demo':undefined
  }
  try {
    assert.equal(productMode.resolveMode(),'production')
    envVersion='trial'
    assert.equal(productMode.resolveMode(),'production')
    envVersion='develop'
    assert.equal(productMode.resolveMode(),'demo')
  } finally { global.wx = previousWx }
})

test('legacy Peter client state migrates once to canonical work and piece IDs', () => {
  const previousWx = global.wx
  const stores = {
    [productMode.PRODUCT_STORAGE_KEY]: {
      favorites:['peter'],
      recent:['peter'],
      progress:{ peter:{ seconds:88,completed:true } },
      listenDaily:{ '2026-09-22:peter':12 },
      results:[{ id:1,title:'The Tale of Peter Rabbit',score:90 }]
    }
  }
  global.wx = {
    isBrowserPreview:true,
    __tingyueMode:'production',
    getStorageSync:key => stores[key],
    setStorageSync:(key,value) => { stores[key] = value }
  }
  try {
    const host = require('../miniprogram/services/host')
    const state = host.read()
    assert.deepEqual(state.favorites, ['peter-rabbit'])
    assert.deepEqual(state.recent, ['peter-rabbit'])
    assert.deepEqual(state.progress['peter-rabbit-01'], { seconds:0,checkpointSeconds:0,completed:false,listenedRanges:[],listenedSeconds:0,coverage:0,completionReason:null,schemaVersion:2 })
    assert.equal(state.progress.peter, undefined)
    assert.equal(state.listenDaily['2026-09-22:peter-rabbit-01'], 12)
    assert.equal(state.results[0].pieceId, 'peter-rabbit-01')
    assert.equal(state.idMigrationVersion, 1)
    assert.equal(state.progressSchemaVersion, 2)
  } finally { global.wx = previousWx }
})

test('atomic host mutations preserve unrelated playback and page updates', () => {
  const previousWx = global.wx
  const stores = { [productMode.PRODUCT_STORAGE_KEY]:{} }
  global.wx = {
    isBrowserPreview:true,
    __tingyueMode:'production',
    getStorageSync:key => stores[key],
    setStorageSync:(key,value) => { stores[key]=value }
  }
  try {
    const host = require('../miniprogram/services/host')
    host.mutate(state => {
      state.progress = { 'peter-rabbit-01':{ seconds:75, completed:false } }
      state.listeningSec = 12
      return state
    })
    host.mutate(state => {
      state.favorites = ['peter-rabbit']
      return state
    })
    const state = host.read()
    assert.deepEqual(state.progress['peter-rabbit-01'], { seconds:75, completed:false })
    assert.equal(state.listeningSec, 12)
    assert.deepEqual(state.favorites, ['peter-rabbit'])
  } finally { global.wx = previousWx }
})
