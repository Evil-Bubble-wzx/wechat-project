const { test } = require('node:test')
const assert = require('node:assert/strict')

function harness(duration=20) {
  const previousWx=global.wx
  let stored={},clock=0,listeners={},manager,playCalls=0
  function freshManager(){
    listeners={}
    manager={
      _src:'',startTime:0,currentTime:0,duration,playbackRate:1,
      get src(){return this._src},
      set src(value){this._src=value;listeners.canplay?.()},
      onTimeUpdate(fn){listeners.time=fn},onEnded(fn){listeners.ended=fn},onError(fn){listeners.error=fn},
      onPlay(fn){listeners.play=fn},onPause(fn){listeners.pause=fn},onStop(fn){listeners.stop=fn},
      onSeeking(fn){listeners.seeking=fn},onSeeked(fn){listeners.seeked=fn},onCanplay(fn){listeners.canplay=fn},onWaiting(fn){listeners.waiting=fn},
      play(){playCalls++;listeners.play?.()},pause(){listeners.pause?.()},stop(){listeners.stop?.()},
      seek(value){listeners.seeking?.();this.currentTime=value;listeners.seeked?.()}
    }
  }
  freshManager()
  global.wx={
    isBrowserPreview:true,__tingyueMode:'production',
    getBackgroundAudioManager:()=>manager,
    getStorageSync:()=>stored,
    setStorageSync:(_key,value)=>{stored=value}
  }
  delete require.cache[require.resolve('../miniprogram/modules/listen-read/player')]
  const player=require('../miniprogram/modules/listen-read/player')
  player._resetForTests();player._setNowForTests(()=>clock)
  const book={id:'peter-rabbit',workId:'peter-rabbit',pieceId:'peter-rabbit-01',contentVersion:1,title:'Peter Rabbit',audioUrl:'https://example.test/peter.mp3',duration}
  return {
    player,book,
    tick(position,wallSeconds=1){clock+=wallSeconds*1000;manager.currentTime=position;listeners.time()},
    seek(position){player.seek(position)},
    end(){listeners.ended()},
    systemPause(){listeners.pause()},
    freshProcess(){player._resetForTests();player._setNowForTests(()=>clock);freshManager()},
    state(){return stored},
    manager(){return manager},
    playCalls(){return playCalls},
    restore(){player._resetForTests();global.wx=previousWx}
  }
}

test('X-02 restores an unfinished piece from its trusted checkpoint without autoplay', () => {
  const h=harness()
  try{
    h.player.playTrack(h.book)
    for(let second=1;second<=8;second++)h.tick(second)
    h.player.pause('user')
    assert.equal(h.state().progress['peter-rabbit-01'].checkpointSeconds,8)
    assert.equal(h.state().listeningSec,8)

    h.freshProcess()
    h.player.selectTrack(h.book)
    const restored=h.player.snapshot()
    assert.equal(restored.position,8)
    assert.equal(restored.status,'paused')
    assert.equal(h.manager()._src,'')
  }finally{h.restore()}
})

test('X-02 explicitly starts a newly assigned background-audio source on iOS', () => {
  const h=harness()
  try{
    assert.equal(h.player.playTrack(h.book),true)
    assert.equal(h.manager().src,h.book.audioUrl)
    assert.equal(h.playCalls(),1)
    assert.equal(h.player.snapshot().status,'playing')
  }finally{h.restore()}
})

test('X-02 tail seeking neither completes a piece nor replaces its trusted checkpoint', () => {
  const h=harness()
  try{
    h.player.playTrack(h.book)
    for(let second=1;second<=6;second++)h.tick(second)
    h.seek(19.5)
    h.tick(20,.5)
    h.end()
    const progress=h.state().progress['peter-rabbit-01']
    assert.equal(progress.completed,false)
    assert.equal(progress.checkpointSeconds,6)
    assert.ok(progress.coverage<.9)

    h.freshProcess();h.player.selectTrack(h.book)
    assert.equal(h.player.snapshot().position,6)
  }finally{h.restore()}
})

test('X-02 merges coverage across restarts and requires the naturally heard tail', () => {
  const h=harness()
  try{
    h.player.playTrack(h.book)
    for(let second=1;second<=10;second++)h.tick(second)
    h.player.pause('user')
    h.freshProcess();h.player.selectTrack(h.book);h.player.playTrack(h.book)
    for(let second=11;second<=20;second++)h.tick(second)
    h.end()
    const progress=h.state().progress['peter-rabbit-01']
    assert.equal(progress.completed,true,JSON.stringify(progress))
    assert.equal(progress.completionReason,'coverage_and_ended')
    assert.equal(progress.coverage,1)
    assert.deepEqual(progress.listenedRanges,[[0,20]])
  }finally{h.restore()}
})

test('X-02 counts wall time at playback speed and rejects abnormal background gaps', () => {
  const h=harness(100)
  try{
    h.player.playTrack(h.book);h.player.setRate(2)
    h.tick(20,10)
    assert.equal(h.state().listeningSec,10)
    h.tick(60,40)
    h.systemPause()
    assert.equal(h.state().listeningSec,10)
    assert.deepEqual(h.state().progress['peter-rabbit-01'].listenedRanges,[[0,20]])
  }finally{h.restore()}
})

test('X-02 invalidates checkpoints when the content version changes', () => {
  const h=harness()
  try{
    h.player.playTrack(h.book)
    for(let second=1;second<=20;second++)h.tick(second)
    h.end()
    assert.equal(h.state().progress['peter-rabbit-01'].completed,true)
    h.freshProcess()
    const nextVersion=Object.assign({},h.book,{contentVersion:2})
    h.player.selectTrack(nextVersion)
    assert.equal(h.player.snapshot().position,0)
    assert.equal(h.player.snapshot().coverage,0)
    assert.equal(h.player.snapshot().completed,false)
    h.player.playTrack(nextVersion)
    for(let second=1;second<=6;second++)h.tick(second)
    h.player.pause('user')
    assert.equal(h.state().progress['peter-rabbit-01'].completed,false)
  }finally{h.restore()}
})
