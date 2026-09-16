const playback = require('../../services/player')
const content = require('../../services/content')
Component({
  properties: { tab: { type: Boolean, value: false }, raised: { type: Boolean, value: false } },
  data: { current: null, clock: '0:00', total: '0:00' },
  lifetimes: {
    attached() { this.unsubscribe = playback.subscribe(current => this.setData({ current, clock: current ? content.time(current.position) : '0:00', total: current ? content.time(current.duration) : '0:00' })) },
    detached() { if (this.unsubscribe) this.unsubscribe() }
  },
  methods: {
    toggle() { playback.toggle() },
    open() { const s = playback.snapshot(); if (s) wx.navigateTo({ url: '/modules/listen-read/pages/reader/index?book=' + s.bookId + '&piece=' + s.pieceId }) }
  }
})
