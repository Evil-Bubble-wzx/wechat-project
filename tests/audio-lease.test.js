const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {createAudioLeaseResolver}=require('../miniprogram/modules/listen-read/audio-lease')
const clone=value=>JSON.parse(JSON.stringify(value))
const wait=()=>new Promise(resolve=>setImmediate(resolve))
const makeManifest=(suffix='old',expiresAt='2026-10-10T01:05:00.000Z')=>{
  const assets=['audio','cover','metadata','quiz','subtitles','text','vocabulary'].map(type=>({type,assetId:'asset-'+type,url:'https://content.test/'+type+'?signature='+suffix,expiresAt,sha256:crypto.createHash('sha256').update(type).digest('hex'),sizeBytes:100,mimeType:type==='audio'?'audio/mpeg':type==='cover'?'image/png':['text'].includes(type)?'text/plain':'application/json'}))
  return {workId:'cloud-book',pieceId:'cloud-piece',contentVersion:1,quizVersion:1,durationMs:60000,assets,manifestSha256:crypto.createHash('sha256').update(JSON.stringify(assets.map(({type,sha256,sizeBytes})=>({type,sha256,sizeBytes})))).digest('hex')}
}
test('buffering without native error renews once at the saved cursor, then ends with a retryable user action',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const h=harness()
  try{
    h.player.playTrack(h.book);for(let i=1;i<=8;i++)h.tick(i)
    h.waiting();h.waiting();assert.equal(h.player.snapshot().status,'loading')
    t.mock.timers.tick(15000);await wait()
    assert.equal(h.calls(),1);assert.equal(h.player.snapshot().position,8);assert.equal(h.manager.currentTime,8)
    const seconds=h.host.read().listeningSec
    h.waiting();t.mock.timers.tick(15000);await wait()
    assert.equal(h.calls(),1);assert.equal(h.player.snapshot().status,'error');assert.equal(h.player.snapshot().position,8)
    assert.equal(h.host.read().listeningSec,seconds)
  }finally{h.restore()}
})
test('user pause during buffering cancels automatic renewal and never resumes playback',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const h=harness()
  try{h.player.playTrack(h.book);h.tick(5);h.waiting();h.player.pause('user');const plays=h.plays();t.mock.timers.tick(15000);await wait();assert.equal(h.calls(),0);assert.equal(h.plays(),plays);assert.equal(h.player.snapshot().status,'paused')}
  finally{h.restore()}
})
test('repeated waiting events keep the playing intent when canplay eventually arrives',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const h=harness()
  try{h.player.playTrack(h.book);h.tick(5);h.waiting();h.waiting();h.canplay();assert.equal(h.player.snapshot().status,'playing');t.mock.timers.tick(15000);await wait();assert.equal(h.calls(),0)}
  finally{h.restore()}
})
function harness(){
  const previousWx=global.wx,host=require('../miniprogram/services/host'),originalScope=host.accountScope(),storage=new Map()
  let clock=Date.parse('2026-10-10T01:00:00.000Z'),listeners={},calls=0,plays=0,userId='account-a'
  const manager={_src:'',currentTime:0,duration:60,startTime:0,playbackRate:1,
    get src(){return this._src},set src(value){this._src=value;this.currentTime=0;listeners.canplay?.()},
    onTimeUpdate:fn=>listeners.time=fn,onPlay:fn=>listeners.play=fn,onPause:fn=>listeners.pause=fn,onStop:fn=>listeners.stop=fn,onError:fn=>listeners.error=fn,onEnded:fn=>listeners.ended=fn,onCanplay:fn=>listeners.canplay=fn,onWaiting:fn=>listeners.waiting=fn,onSeeking:fn=>listeners.seeking=fn,onSeeked:fn=>listeners.seeked=fn,
    play(){plays++;listeners.play?.()},pause(){listeners.pause?.()},seek(position){listeners.seeking?.();this.currentTime=position;listeners.seeked?.()}
  }
  global.wx={isBrowserPreview:true,__tingyueMode:'production',getBackgroundAudioManager:()=>manager,getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,clone(value))}
  host.setAccountScope(userId)
  const player=require('../miniprogram/modules/listen-read/player');player._resetForTests();player._setNowForTests(()=>clock)
  const manifest=makeManifest(),book={id:'cloud-book',workId:'cloud-book',pieceId:'cloud-piece',contentVersion:1,title:'Cloud',duration:60,localAudio:manifest.assets[0].url,remoteManifest:manifest,audioAccountScope:userId,remote:true}
  const api={isAuthenticated:()=>!!userId,currentUser:()=>({userId}),getManifest:async(piece,version)=>{calls++;assert.equal(piece,'cloud-piece');assert.equal(version,1);return makeManifest('new','2026-10-10T01:10:00.000Z')}}
  player._setSourceResolverForTests(createAudioLeaseResolver({api,host}))
  return {player,host,manager,api,book,storage,
    tick(position,seconds=1){clock+=seconds*1000;manager.currentTime=position;listeners.time()},
    error(){manager.currentTime=0;listeners.error({errCode:10002,errMsg:'Network error'})},
    waiting(){listeners.waiting()},canplay(){listeners.canplay()},nativePause(){listeners.pause()},nativePlay(){listeners.play()},
    expire(){clock+=600000},calls:()=>calls,plays:()=>plays,setUser:id=>{userId=id;host.setAccountScope(id)},
    restore(){player._resetForTests();host.setAccountScope(originalScope);global.wx=previousWx},
  }
}
test('expired audio is renewed before fetching and preserves exact cursor, rate, loop and coverage',async()=>{
  const h=harness()
  try{
    h.player.playTrack(h.book);for(let i=1;i<=8;i++)h.tick(i)
    h.player.setRate(1.5);h.player.setLoop(true);h.player.pause('user')
    const before=h.player.snapshot(),count=h.plays();h.expire();h.player.resume()
    assert.equal(h.player.snapshot().status,'renewing');assert.equal(h.manager.src,h.book.localAudio)
    await wait()
    const after=h.player.snapshot()
    assert.equal(h.calls(),1);assert.equal(after.sessionId,before.sessionId);assert.equal(after.position,8);assert.equal(after.checkpointPosition,8)
    assert.equal(after.rate,1.5);assert.equal(after.loop,true);assert.deepEqual(after.listenedRanges,before.listenedRanges);assert.equal(h.plays(),count+1)
    assert.match(h.manager.src,/signature=new/);assert.equal(h.host.read().listeningSec,8)
  }finally{h.restore()}
})
test('native remote error renews once and never resets a nonzero cursor to the failed transport zero',async()=>{
  const h=harness()
  try{
    h.player.playTrack(h.book);for(let i=1;i<=8;i++)h.tick(i)
    h.error();await wait();assert.equal(h.calls(),1);assert.equal(h.manager.currentTime,8);assert.equal(h.player.snapshot().status,'playing')
    h.error();await wait();assert.equal(h.calls(),1);assert.equal(h.player.snapshot().status,'error')
    h.player.resume();await wait();assert.equal(h.calls(),2);assert.equal(h.player.snapshot().status,'playing')
  }finally{h.restore()}
})
test('user pause during renewal keeps the renewed source paused without autoplay',async()=>{
  const h=harness();let resolve
  try{
    h.player.playTrack(h.book);for(let i=1;i<=8;i++)h.tick(i)
    h.api.getManifest=()=>new Promise(done=>{resolve=done})
    h.error();await wait();h.player.pause('user');const plays=h.plays()
    resolve(makeManifest('paused','2026-10-10T01:10:00.000Z'));await wait()
    assert.equal(h.player.snapshot().status,'paused');assert.equal(h.player.snapshot().pauseReason,'user');assert.equal(h.plays(),plays);assert.equal(h.player.snapshot().position,8)
    h.player.resume();assert.match(h.manager.src,/signature=paused/)
  }finally{h.restore()}
})
test('system pause during renewal also cancels automatic playback intent',async()=>{
  const h=harness();let resolve
  try{
    h.player.playTrack(h.book);h.api.getManifest=()=>new Promise(done=>{resolve=done})
    h.error();await wait();h.nativePause();const plays=h.plays()
    resolve(makeManifest('system','2026-10-10T01:10:00.000Z'));await wait()
    assert.equal(h.player.snapshot().status,'paused');assert.equal(h.plays(),plays)
  }finally{h.restore()}
})
test('seek during renewal uses the new target but does not grant the skipped range',async()=>{
  const h=harness();let resolve
  try{
    h.player.playTrack(h.book);for(let i=1;i<=8;i++)h.tick(i)
    h.api.getManifest=()=>new Promise(done=>{resolve=done});h.error();await wait()
    h.player.seek(40);resolve(makeManifest('seek','2026-10-10T01:10:00.000Z'));await wait()
    assert.equal(h.manager.currentTime,40);assert.equal(h.player.snapshot().checkpointPosition,8);assert.deepEqual(h.player.snapshot().listenedRanges,[[0,8]])
  }finally{h.restore()}
})
test('selecting another chapter discards an in-flight renewal without starting the old audio',async()=>{
  const h=harness();let resolve
  try{
    h.player.playTrack(h.book);h.api.getManifest=()=>new Promise(done=>{resolve=done});h.error();await wait()
    const next={id:'other',workId:'other',pieceId:'other-piece',contentVersion:1,title:'Other',duration:60,audioUrl:'https://content.test/other.mp3'}
    h.player.selectTrack(next);const plays=h.plays()
    resolve(makeManifest('late','2026-10-10T01:10:00.000Z'));await wait()
    assert.equal(h.player.snapshot().pieceId,'other-piece');assert.equal(h.player.snapshot().status,'paused');assert.equal(h.plays(),plays)
  }finally{h.restore()}
})
test('a foreground verified lease replaces pending renewal without accepting its late response',async()=>{
  const h=harness();let resolve
  try{
    h.player.playTrack(h.book);for(let i=1;i<=8;i++)h.tick(i)
    h.api.getManifest=()=>new Promise(done=>{resolve=done});h.error();await wait()
    h.player.setRate(1.25);assert.equal(h.player.snapshot().position,8)
    const manifest=makeManifest('foreground','2026-10-10T01:20:00.000Z')
    h.player.selectTrack({...h.book,localAudio:manifest.assets[0].url,remoteManifest:manifest})
    assert.equal(h.player.snapshot().status,'playing');assert.equal(h.manager.currentTime,8)
    resolve(makeManifest('late','2026-10-10T01:10:00.000Z'));await wait()
    assert.match(h.manager.src,/signature=foreground/);assert.equal(h.player.snapshot().rate,1.25)
  }finally{h.restore()}
})

test('track selection before renewal dispatch prevents even the stale API call',async()=>{
  const h=harness()
  try{
    h.player.playTrack(h.book);h.error()
    h.player.selectTrack({id:'other',pieceId:'other-piece',title:'Other',audioUrl:'https://content.test/other.mp3',duration:60})
    await wait();assert.equal(h.calls(),0);assert.equal(h.player.snapshot().pieceId,'other-piece')
  }finally{h.restore()}
})
test('account change drops renewal response and late playback events cannot write progress into B',async()=>{
  const h=harness();let resolve
  try{
    h.player.playTrack(h.book);for(let i=1;i<=8;i++)h.tick(i)
    h.api.getManifest=()=>new Promise(done=>{resolve=done});h.error();await wait()
    h.setUser('account-b');h.host.write({words:['b-only']});h.tick(9);h.nativePause();h.player.saveNow();h.player.reloadScope()
    resolve(makeManifest('account-a-late','2026-10-10T01:10:00.000Z'));await wait()
    assert.equal(h.host.read().progress?.['cloud-piece'],undefined);assert.deepEqual(h.host.read().words,['b-only'])
    assert.equal(h.player.resume(),false);assert.equal(h.player.snapshot().error,'audio_account_changed')
  }finally{h.restore()}
})
test('renewal identity changes are rejected, including digest, version, quiz, duration and asset identity',async()=>{
  for(const mutate of [m=>m.contentVersion=2,m=>m.quizVersion=2,m=>m.durationMs=61000,m=>m.manifestSha256='f'.repeat(64),m=>m.assets[0].assetId='other',m=>m.assets[0].sha256='f'.repeat(64),m=>m.assets[0].url='http://remote.test/audio',m=>m.assets[0].expiresAt='invalid']){
    const h=harness()
    try{
      h.player.playTrack(h.book);h.api.getManifest=async()=>{const manifest=makeManifest('bad','2026-10-10T01:10:00.000Z');mutate(manifest);return manifest}
      h.error();await wait();assert.equal(h.player.snapshot().status,'error');assert.equal(h.manager.src,h.book.localAudio);assert.equal(h.plays(),1)
    }finally{h.restore()}
  }
})
test('permission or version rejection cannot be bypassed by pause then replay of a cached URL',async()=>{
  for(const code of ['CONTENT_ACCESS_DENIED','CONTENT_VERSION_UNAVAILABLE','RESOURCE_NOT_FOUND']){
    const h=harness()
    try{
      let requests=0;h.player.playTrack(h.book)
      h.api.getManifest=async()=>{requests++;throw Object.assign(Error('denied'),{serverCode:code})}
      h.error();await wait();assert.equal(h.player.snapshot().pauseReason,'content_unavailable')
      h.player.pause('user');h.player.resume();await wait();assert.equal(requests,2);assert.equal(h.plays(),1)
    }finally{h.restore()}
  }
})
test('network renewal failure preserves checkpoint and immutable coverage for explicit retry',async()=>{
  const h=harness()
  try{
    h.player.playTrack(h.book);for(let i=1;i<=8;i++)h.tick(i)
    const good=h.api.getManifest;h.api.getManifest=async()=>{throw Object.assign(Error('offline'),{kind:'network'})}
    h.error();await wait();assert.equal(h.player.snapshot().error,'audio_renewal_failed');assert.equal(h.player.snapshot().checkpointPosition,8)
    h.api.getManifest=good;h.player.resume();await wait();assert.equal(h.player.snapshot().position,8);assert.deepEqual(h.player.snapshot().listenedRanges,[[0,8]])
  }finally{h.restore()}
})
test('pause during buffering is not undone by a late canplay or play event',()=>{
  const h=harness()
  try{
    h.player.playTrack(h.book);h.waiting();h.player.pause('user');h.canplay();h.nativePlay()
    assert.equal(h.player.snapshot().status,'paused');assert.equal(h.player.snapshot().pauseReason,'user')
  }finally{h.restore()}
})
test('local bundled audio errors never cause an authenticated renewal request',async()=>{
  const h=harness()
  try{
    h.player.playTrack({id:'local',pieceId:'local-piece',title:'Local',audioUrl:'https://content.test/local.mp3',duration:60})
    h.error();await wait();assert.equal(h.calls(),0);assert.equal(h.player.snapshot().status,'error')
  }finally{h.restore()}
})
