const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {createSha256}=require('../miniprogram/modules/listen-read/sha256-stream')
const {createAudioCache,DEFAULT_LIMIT}=require('../miniprogram/modules/listen-read/audio-cache')
const clone=x=>JSON.parse(JSON.stringify(x))
const {harness}=require('./helpers/audio-cache-runtime.cjs')
test('incremental SHA matches Node across padding and read chunk boundaries',()=>{
 for(const size of [0,1,55,56,63,64,65,1024,262149]){const b=crypto.randomBytes(size),h=createSha256();for(let p=0;p<size;p+=31)h.update(b.subarray(p,p+31));assert.equal(h.digest(),crypto.createHash('sha256').update(b).digest('hex'))}
})
test('audio persists only after checksum verification and is reused after a fresh cache instance',async()=>{
 const h=harness(),f=h.fixture();h.storage.set('learning',{points:123,progress:8});assert.equal(h.cache.summary('a').limit,DEFAULT_LIMIT)
 const stages=[];const first=await h.cache.ensure('a',f.book,f.bundle,f.manifest,{onProgress:p=>stages.push(p.stage)});assert.ok(first.path.startsWith('wxfile://usr/tingyue-audio-v1/'));assert.deepEqual(stages,['download','verify','ready'])
 const restored=createAudioCache(h.runtime),second=await restored.get('a','piece-1',1);assert.equal(second.path,first.path);assert.equal(second.bundle.quiz.questions.length,1);assert.equal(await restored.get('b','piece-1',1),null)
 await restored.ensure('a',f.book,f.bundle,f.manifest);assert.equal(h.downloads(),1);assert.equal(h.modals(),0)
 assert.ok(!JSON.stringify(h.storage.get('tingyue.audio-cache.v1')).includes('https://'));assert.deepEqual(h.storage.get('learning'),{points:123,progress:8})
 await restored.remove('a',restored.summary('a').items[0].key);assert.equal(h.files.size,0);assert.deepEqual(h.storage.get('learning'),{points:123,progress:8})
})
test('checksum, disk failure and account change never install an unusable download',async()=>{
 const h=harness(),f=h.fixture();h.resources.set(f.manifest.assets[0].url,Buffer.alloc(f.bytes.length,0));await assert.rejects(h.cache.ensure('a',f.book,f.bundle,f.manifest),{code:'AUDIO_CHECKSUM_MISMATCH'});assert.equal(h.files.size,0);assert.equal(h.cache.summary('a').items.length,0)
 h.resources.set(f.manifest.assets[0].url,f.bytes);h.setDiskFull(true);await assert.rejects(h.cache.ensure('a',f.book,f.bundle,f.manifest));assert.equal(h.cache.summary('a').items.length,0)
 h.setDiskFull(false);let valid=true;await assert.rejects(h.cache.ensure('a',f.book,f.bundle,f.manifest,{current:()=>valid,onProgress:p=>{if(p.stage==='verify')valid=false}}),{code:'DOWNLOAD_CANCELLED'});assert.equal(h.files.size,0)
})
test('mobile data asks consent; denied download and offline miss perform no network transfer',async()=>{
 const h=harness(),f=h.fixture();h.setNetwork('4g');h.setConfirm(false);await assert.rejects(h.cache.ensure('a',f.book,f.bundle,f.manifest),{code:'DOWNLOAD_CANCELLED'});assert.equal(h.downloads(),0)
 h.setConfirm(true);await h.cache.ensure('a',f.book,f.bundle,f.manifest);assert.equal(h.modals(),2)
 const next=h.fixture('piece-2');h.setNetwork('none');await assert.rejects(h.cache.ensure('a',next.book,next.bundle,next.manifest),{code:'OFFLINE_NOT_DOWNLOADED'});assert.equal(h.downloads(),1)
})
test('concurrent current-chapter and whole-book requests share bytes and upgrade manual retention',async()=>{
 const h=harness(),f=h.fixture();await Promise.all([h.cache.ensure('a',f.book,f.bundle,f.manifest),h.cache.ensure('a',f.book,f.bundle,f.manifest,{pinned:true})]);assert.equal(h.downloads(),1);assert.equal(h.cache.summary('a').items[0].pinned,true)
 h.cache.rememberOwner('a');assert.equal(createAudioCache(h.runtime).rememberedOwner(),'a');h.cache.rememberOwner('b');assert.equal(h.cache.rememberedOwner(),null);h.cache.rememberOwner(null);assert.equal(h.cache.rememberedOwner(),null)
})
test('capacity evicts oldest automatic files but refuses to evict manual or active audio',async()=>{
 const h=harness(),a=h.fixture('a'),b=h.fixture('b');const saved=await h.cache.ensure('owner',a.book,a.bundle,a.manifest);const idx=h.storage.get('tingyue.audio-cache.v1'),key=Object.keys(idx.entries)[0];idx.limit=64*1024*1024;idx.entries[key].sizeBytes=idx.limit;h.storage.set('tingyue.audio-cache.v1',idx)
 h.cache.setActivePath(saved.path);await assert.rejects(h.cache.ensure('owner',b.book,b.bundle,b.manifest),{code:'CACHE_LIMIT_REACHED'});assert.ok(h.files.has(saved.path))
 h.cache.setActivePath(null);idx.entries[key].pinned=true;h.storage.set('tingyue.audio-cache.v1',idx);await assert.rejects(h.cache.ensure('owner',b.book,b.bundle,b.manifest),{code:'CACHE_LIMIT_REACHED'});assert.ok(h.files.has(saved.path))
 idx.entries[key].pinned=false;h.storage.set('tingyue.audio-cache.v1',idx);await h.cache.ensure('owner',b.book,b.bundle,b.manifest);assert.ok(!h.files.has(saved.path));assert.equal(h.cache.summary('owner').items[0].pieceId,'b')
})
test('revoked chapter and altered offline package are never opened offline',async()=>{
 const h=harness(),f=h.fixture(),saved=await h.cache.ensure('a',f.book,f.bundle,f.manifest);h.cache.revoke('a',f.book.pieceId);assert.equal(await h.cache.get('a',f.book.pieceId),null)
 const second=h.fixture('piece-2');await h.cache.ensure('a',second.book,second.bundle,second.manifest);const idx=h.storage.get('tingyue.audio-cache.v1'),entry=Object.values(idx.entries).find(e=>e.pieceId==='piece-2');h.files.set(entry.packagePath,Buffer.from('{}'));assert.equal(await h.cache.get('a','piece-2'),null);assert.ok(!h.files.has(entry.path));assert.ok(h.files.has(saved.path))
})
test('cold offline identity restores no bearer credentials, and reconnect authenticates the current WeChat account',async()=>{
 const h=harness(),f=h.fixture();await h.cache.ensure('a',f.book,f.bundle,f.manifest);h.cache.rememberOwner('a');h.setNetwork('none')
 const {createBackendApi}=require('../miniprogram/services/api'),host=require('../miniprogram/services/host');let requests=0
 h.runtime.login=o=>o.success({code:'real-wx-code'})
 const api=createBackendApi({runtime:h.runtime,configuration:{enabled:true,apiRoot:'https://api.test/api/v1',development:false},transport:async req=>{requests++;return {statusCode:req.url.endsWith('/session/wechat')?201:200,data:req.url.endsWith('/session/wechat')?{accessToken:'new-access',refreshToken:'new-refresh'}:{userId:'b'},header:{'X-API-Contract-Version':'api-contract-v2.9.0'}}}})
 try{
  assert.equal(api.currentUser().userId,'a');assert.equal(api.offlineMode(),true);assert.equal(api.isAuthenticated(),false);assert.equal(api._tokenStore.getAccessToken(),null)
  assert.equal(await api.reconnectOffline(),false);assert.equal(requests,0)
  h.setNetwork('wifi');assert.equal(await api.reconnectOffline(),true);assert.equal(api.currentUser().userId,'b');assert.equal(host.accountScope(),'b');assert.equal(api.isAuthenticated(),true);assert.equal(await h.cache.get('b','piece-1'),null)
  assert.ok(!JSON.stringify([...h.storage]).includes('new-access'));assert.ok(!JSON.stringify([...h.storage]).includes('new-refresh'))
  await api.logout();assert.equal(h.cache.rememberedOwner(),null);assert.equal(h.cache.summary('a').items.length,1)
 }finally{host.setAccountScope(null)}
})
test('interrupted install stays unavailable and retry replaces only its owned files',async()=>{
 const h=harness(),f=h.fixture();const original=await h.cache.ensure('a',f.book,f.bundle,f.manifest),idx=h.storage.get('tingyue.audio-cache.v1'),key=Object.keys(idx.entries)[0];idx.entries[key].complete=false;h.storage.set('tingyue.audio-cache.v1',idx)
 const restarted=createAudioCache(h.runtime);assert.equal(await restarted.get('a','piece-1'),null);h.cache.rememberOwner('a');assert.equal(restarted.rememberedOwner(),null)
 const saved=await restarted.ensure('a',f.book,f.bundle,f.manifest);assert.equal(saved.path,original.path);assert.equal(h.downloads(),2);assert.equal(restarted.summary('a').items[0].complete,true)
 h.files.set(saved.path,Buffer.alloc(f.bytes.length,0));assert.equal(await createAudioCache(h.runtime).get('a','piece-1'),null);assert.equal(h.files.size,0)
})
test('release and trial cannot open development-only cached content or restore its offline identity',async()=>{
 const h=harness(),f=h.fixture();await h.cache.ensure('a',f.book,f.bundle,f.manifest);h.cache.rememberOwner('a')
 for(const envVersion of ['trial','release']){const runtime={...h.runtime,getAccountInfoSync:()=>({miniProgram:{envVersion}})},cache=createAudioCache(runtime);assert.equal(await cache.get('a','piece-1'),null);assert.equal(cache.rememberedOwner(),null);assert.equal(cache.summary('a').items.length,0)}
 assert.equal(h.cache.summary('a').items.length,1)
})
test('failed physical deletion retains the index and never reports freed storage',async()=>{
 const h=harness(),f=h.fixture();const saved=await h.cache.ensure('a',f.book,f.bundle,f.manifest),key=h.cache.summary('a').items[0].key,used=h.cache.summary('a').used
 h.runtime.getFileSystemManager().unlink=options=>options.fail({errMsg:'permission denied'})
 await assert.rejects(h.cache.remove('a',key),{code:'CACHE_DELETE_FAILED'});assert.equal(h.cache.summary('a').used,used);assert.equal(h.cache.summary('a').items.length,1);assert.ok(h.files.has(saved.path))
})
