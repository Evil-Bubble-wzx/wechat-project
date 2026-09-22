const { test } = require('node:test')
const assert = require('node:assert/strict')
const promotion = require('../miniprogram/modules/promotion/demo')

test('invite reward creates one coupon and demo purchase redeems it', () => {
  const now = Date.UTC(2026, 8, 20)
  const state = { user:{ id:'demo' }, demoCoupons:[], demoPurchases:[] }
  promotion.simulateInvitation(state, now)
  assert.equal(state.demoCoupons.length, 1)
  assert.equal(promotion.activeCoupons(state, now).length, 1)
  assert.throws(() => promotion.simulateInvitation(state, now + 1))
  const result = promotion.simulatePurchase(state, 'little-seed', now + 1)
  assert.deepEqual(result, { total:10, couponUsed:true })
  assert.equal(state.demoCoupons[0].used, true)
  assert.equal(promotion.activeCoupons(state, now + 1).length, 0)
  assert.throws(() => promotion.simulatePurchase(state, 'little-seed', now + 2))
})

test('all story audio, including bundled chapters, uses background audio', () => {
  const previousWx = global.wx
  let backgroundCalls = 0, innerCalls = 0
  const manager = {
    src:'', currentTime:0, duration:10, playbackRate:1,
    onTimeUpdate() {}, onEnded() {}, onError() {},
    play() {}, pause() {}, stop() {}, seek() {}
  }
  global.wx = {
    getBackgroundAudioManager() { backgroundCalls++; return manager },
    createInnerAudioContext() { innerCalls++; return manager }
  }
  try {
    delete require.cache[require.resolve('../miniprogram/modules/listen-read/player')]
    const player = require('../miniprogram/modules/listen-read/player')
    assert.equal(player.play({ title:'Chapter', author:'Reader', cover:'/assets/cover.png', localAudio:'/assets/audio/chapter.mp3' }, () => {}, () => {}, () => {}), true)
    assert.equal(backgroundCalls, 1)
    assert.equal(innerCalls, 0)
    assert.equal(manager.src, '/assets/audio/chapter.mp3')
    assert.equal(manager.coverImgUrl, '/assets/cover.png')
  } finally { global.wx = previousWx }
})

test('playback session survives page subscriptions and system media controls', () => {
  const previousWx = global.wx
  const listeners = {}
  let stored = {}
  const manager = {
    _src:'', currentTime:0, duration:322, playbackRate:1,
    get src() { return this._src },
    set src(value) { this._src=value;listeners.play?.() },
    onTimeUpdate(fn) { listeners.time=fn }, onEnded(fn) { listeners.ended=fn }, onError(fn) { listeners.error=fn },
    onPlay(fn) { listeners.play=fn }, onPause(fn) { listeners.pause=fn }, onStop(fn) { listeners.stop=fn },
    play() { listeners.play?.() }, pause() { listeners.pause?.() }, stop() { listeners.stop?.() },
    seek(value) { this.currentTime=value }
  }
  global.wx = {
    isBrowserPreview:true,
    __tingyueMode:'production',
    getBackgroundAudioManager:() => manager,
    getStorageSync:() => stored,
    setStorageSync:(_key,value) => { stored=value }
  }
  try {
    delete require.cache[require.resolve('../miniprogram/modules/listen-read/player')]
    const player = require('../miniprogram/modules/listen-read/player')
    player._resetForTests()
    const first = { id:'peter-rabbit', workId:'peter-rabbit', pieceId:'peter-rabbit-01', title:'Peter Rabbit', audioUrl:'https://example.test/peter.mp3', duration:322 }
    const second = { id:'peter-rabbit', workId:'peter-rabbit', pieceId:'peter-rabbit-02', title:'Peter Rabbit 2', audioUrl:'https://example.test/peter-2.mp3', duration:200 }
    const oldSnapshots = []
    const currentSnapshots = []
    const unsubscribe = player.subscribe(value => oldSnapshots.push(value))
    assert.equal(player.playTrack(first), true)
    player.setRate(1.25)
    manager.currentTime=10;listeners.time()
    manager.currentTime=11;listeners.time()
    assert.equal(stored.progress['peter-rabbit-01'].seconds, 11)
    assert.equal(stored.listeningSec, 1)

    unsubscribe()
    const oldCount = oldSnapshots.length
    player.subscribe(value => currentSnapshots.push(value))
    listeners.pause()
    assert.equal(player.snapshot().status, 'paused')
    assert.equal(player.snapshot().pauseReason, 'system')
    listeners.play()
    assert.equal(player.snapshot().status, 'playing')
    assert.equal(oldSnapshots.length, oldCount)
    assert.ok(currentSnapshots.length >= 3)

    player.selectTrack(second)
    const replaced = player.snapshot()
    assert.equal(replaced.pieceId, 'peter-rabbit-02')
    assert.equal(replaced.position, 0)
    assert.equal(replaced.rate, 1.25)
    assert.equal(replaced.status, 'paused')
    player._resetForTests()
  } finally { global.wx = previousWx }
})

test('listening metric uses compact five-character display', () => {
  const previousWx = global.wx
  let stored = { listeningSec:57 }
  global.wx = {
    isBrowserPreview:true,
    __tingyueMode:'demo',
    getStorageSync:() => stored,
    setStorageSync:(_key, value) => { stored = value },
    getWindowInfo:() => ({ statusBarHeight:24 }),
    showToast:() => {}
  }
  try {
    const { createPage } = require('../miniprogram/ui/controller')
    const page = createPage('me')
    page.setData = patch => Object.assign(page.data, patch)
    page.onLoad({})
    assert.equal(page.data.stats.listening, '00:57')
    stored.listeningSec = 3661
    page.refresh()
    assert.equal(page.data.stats.listening, '01:01')

    stored.user = { id:'demo', name:'小小阅读家' }
    const invite = createPage('invite')
    invite.setData = patch => Object.assign(invite.data, patch)
    invite.onLoad({})
    invite.claimInviteReward()
    assert.equal(invite.data.couponCount, 1)

    const detail = createPage('detail')
    detail.setData = patch => Object.assign(detail.data, patch)
    detail.onLoad({ id:'little-seed' })
    detail.openPurchase()
    assert.equal(detail.data.sheet, 'purchase')
    detail.confirmPurchase()
    assert.equal(detail.data.sheet, 'purchaseResult')
    assert.equal(detail.data.purchaseResult.total, '¥10')
    assert.equal(detail.data.purchaseResult.couponUsed, true)
  } finally { global.wx = previousWx }
})
