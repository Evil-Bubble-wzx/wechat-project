const test=require('node:test'),assert=require('node:assert/strict')
const {harness}=require('./helpers/audio-cache-runtime.cjs')
test('offline downloaded chapter plays its local file and preserves unverified Quiz and progress for later sync',async()=>{
 const h=harness(),f=h.fixture();await h.cache.ensure('a',f.book,f.bundle,f.manifest);h.cache.rememberOwner('a');h.setNetwork('none')
 const previous=global.wx,listeners={};let clock=0
 const manager={src:'',currentTime:0,duration:10,startTime:0,playbackRate:1,play(){listeners.play?.()},pause(){listeners.pause?.()},seek(t){this.currentTime=t;listeners.seeked?.()}}
 for(const [method,event]of Object.entries({onTimeUpdate:'time',onPlay:'play',onPause:'pause',onStop:'stop',onError:'error',onEnded:'end',onCanplay:'canplay',onWaiting:'waiting',onSeeking:'seeking',onSeeked:'seeked'}))manager[method]=fn=>listeners[event]=fn
 h.runtime.getBackgroundAudioManager=()=>manager;h.runtime.showToast=()=>{};h.runtime.getAccountInfoSync=()=>({miniProgram:{envVersion:'develop'}});global.wx=h.runtime
 const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host'),player=require('../miniprogram/modules/listen-read/player'),{createPage}=require('../miniprogram/ui/controller'),sync=require('../miniprogram/modules/sync/progress-sync')
 const old={currentUser:api.currentUser,offlineMode:api.offlineMode,isAuthenticated:api.isAuthenticated,available:api.available}
 api.currentUser=()=>({userId:'a',offline:true});api.offlineMode=()=>true;api.isAuthenticated=()=>false;api.available=()=>false;host.setAccountScope('a');player._resetForTests();player._setNowForTests(()=>clock)
 const page=route=>{const p=createPage(route);p.setData=patch=>Object.assign(p.data,patch);p.data.book={...f.book,remote:true};return p}
 try{
  const p=page('player');await p.loadRemote();assert.equal(p.data.remoteContentStatus,'ready');assert.ok(p.data.book.localAudio.startsWith('wxfile://usr/'));assert.equal(p.data.offlineContent,true)
  p.togglePlay();assert.equal(manager.src,p.data.book.localAudio);assert.equal(player.releaseCachedTrack('a','piece-1',1),false);clock=5000;manager.currentTime=5;listeners.time();player.pause('user')
  const state=host.read();assert.equal(state.progress['piece-1'].checkpointSeconds,5);assert.equal(Object.keys(state.progressSyncOutbox).length,1);assert.equal(state.learningScoreSummary,undefined)
  const quiz=page('quiz');assert.equal(await quiz.loadOfflineContent(),true);quiz.data.answer=0;quiz.nextQuestion();quiz.nextQuestion()
  assert.equal(host.read().results[0].status,'local_unverified');assert.equal(host.read().results[0].score,100);assert.match(quiz.data.quizResultStatus,/离线/)
  assert.equal(player.releaseCachedTrack('a','piece-1',1),true);await h.cache.remove('a',h.cache.summary('a').items[0].key);assert.equal(h.cache.summary('a').items.length,0);assert.equal(player.resume(),false);assert.equal(host.read().results[0].status,'local_unverified');assert.equal(host.read().progress['piece-1'].checkpointSeconds,5);host.setAccountScope('b');assert.equal(await p.loadOfflineContent(),false);assert.equal(player.playTrack(p.data.book),false)
 }finally{Object.assign(api,old);player._resetForTests();sync._resetForTests();host.setAccountScope(null);global.wx=previous}
})
test('whole-book download pins every chapter and retries only failed chapters',async()=>{
 const h=harness(),one=h.fixture('one'),two=h.fixture('two'),previous=global.wx;h.runtime.showToast=()=>{};global.wx=h.runtime
 const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host'),catalog=require('../miniprogram/modules/catalog/remote-catalog'),resources=require('../miniprogram/modules/catalog/remote-resources'),{createPage}=require('../miniprogram/ui/controller')
 const names=['currentUser','isAuthenticated','available','getWork','getManifest'],old=Object.fromEntries(names.map(n=>[n,api[n]])),oldBundle=resources.loadBundle
 const pieces=[one,two].map(f=>({pieceId:f.book.pieceId,title:f.book.pieceId,currentContentVersion:1,quizVersion:1,durationMs:10000,access:'free',metadata:{}}))
 const work={work:{workId:'work',title:'Story',pieceCount:2,access:'free',metadata:{}},pieces}
 api.currentUser=()=>({userId:'a'});api.isAuthenticated=()=>true;api.available=()=>true;api.getWork=async()=>work;api.getManifest=async id=>(id==='one'?one:two).manifest;resources.loadBundle=async(_m,e)=>(e.pieceId==='one'?one:two).bundle
 host.setAccountScope('a');catalog.setScope('a');catalog.replace({items:[work.work],nextCursor:null},'a');const book=catalog.putWork(work,'a')
 const p=createPage('detail');p.setData=patch=>Object.assign(p.data,patch);p.data.book=book
 try{
  h.resources.set(two.manifest.assets[0].url,Buffer.alloc(two.bytes.length,0));await p.downloadBook();assert.equal(h.cache.summary('a').items.length,1);assert.equal(h.cache.summary('a').items[0].pinned,true);assert.ok(p.data.downloadError)
  h.resources.set(two.manifest.assets[0].url,two.bytes);await p.downloadBook();assert.equal(h.cache.summary('a').items.length,2);assert.ok(h.cache.summary('a').items.every(e=>e.pinned));assert.equal(h.downloads(),3);assert.equal(p.data.bookDownloadBusy,false);assert.match(p.data.bookDownloadLabel,/已下载/)
 }finally{Object.assign(api,old);resources.loadBundle=oldBundle;host.setAccountScope(null);catalog.reset();global.wx=previous}
})
test('downloaded chapter is ready before a slow online permission check completes',async()=>{
 const h=harness(),f=h.fixture();await h.cache.ensure('a',f.book,f.bundle,f.manifest);const previous=global.wx;global.wx=h.runtime
 const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host'),player=require('../miniprogram/modules/listen-read/player'),{createPage}=require('../miniprogram/ui/controller')
 const old=Object.fromEntries(['currentUser','offlineMode','isAuthenticated','available','getManifest'].map(n=>[n,api[n]]));let resolve,checks=0
 api.currentUser=()=>({userId:'a'});api.offlineMode=()=>false;api.isAuthenticated=()=>true;api.available=()=>true;api.getManifest=()=>{checks++;return new Promise(r=>resolve=r)};host.setAccountScope('a')
 const p=createPage('player');p.setData=patch=>Object.assign(p.data,patch);p.data.book={...f.book,remote:true};p.activateQuizSync=()=>{};p.activateLibrarySync=()=>{};p.loadLearningScore=async()=>{}
 try{await p.loadRemote();assert.equal(p.data.remoteContentStatus,'ready');assert.ok(p.data.book.localAudio.startsWith('wxfile://usr/'));assert.equal(checks,1);resolve(f.manifest);await new Promise(r=>setImmediate(r))}
 finally{Object.assign(api,old);player._resetForTests();host.setAccountScope(null);global.wx=previous}
})
