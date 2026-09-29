const test = require('node:test')
const assert = require('node:assert/strict')

const { createProgressSyncManager, STORAGE_PREFIX } = require('../miniprogram/modules/sync/progress-sync')

function localEntry(overrides = {}) {
  return Object.assign({
    contentVersion:1,duration:20,checkpointSeconds:5,listenedRanges:[[0,5]],
    naturalEndObserved:false,updatedAt:'2026-09-29T01:00:00.000Z'
  },overrides)
}

function harness(handler) {
  const storage=new Map(),requests=[],remote=[],scheduled=[]
  let local={ 'peter-rabbit-01':localEntry() },userId='user-a',authenticated=true
  const runtime={getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value)}
  const manager=createProgressSyncManager({
    runtime,api:{},host:{},player:{},random:()=>0,now:()=>Date.parse('2026-09-29T02:00:00.000Z'),
    schedule:(fn,delay)=>{const timer={fn,delay};scheduled.push(timer);return timer},cancel:()=>{},
    readLocalProgress:()=>local,isAuthenticated:()=>authenticated,currentUser:()=>({userId}),
    applyRemote:progress=>remote.push(progress),
    submit:async request=>{requests.push(request);return handler(request,requests.length)}
  })
  return {manager,storage,requests,remote,scheduled,setLocal:value=>{local=value},setUser:value=>{userId=value},setAuthenticated:value=>{authenticated=value}}
}

function response(request, overrides = {}) {
  return Object.assign({schemaVersion:1,batchId:request.batchId,serverTime:'2026-09-29T02:00:00.000Z',operations:[],changes:[],nextCursor:'s02-cursor-v1:0:'+'a'.repeat(64),hasMore:false},overrides)
}

test('S-02 excludes pre-login progress and queues only evidence produced after activation', async () => {
  const h=harness(request=>response(request))
  h.manager.activate('user-a',{sync:false})
  assert.equal(h.manager.record(localEntry(),'peter-rabbit-01',false),false)
  const advanced=localEntry({checkpointSeconds:8,listenedRanges:[[0,8]],updatedAt:'2026-09-29T01:01:00.000Z'})
  h.setLocal({'peter-rabbit-01':advanced})
  assert.equal(h.manager.record(advanced,'peter-rabbit-01',false),true)
  await h.manager.trigger('test',false)

  assert.equal(h.requests.length,1)
  assert.deepEqual(h.requests[0].operations[0].listenedRangeDeltasMs,[[5000,8000]])
  assert.equal(h.requests[0].operations[0].checkpointMs,8000)
  assert.match(h.requests[0].operations[0].operationId,/^s02-op-v1:[a-f0-9]{64}$/)
  assert.match(h.requests[0].batchId,/^s02-batch-v1:[a-f0-9]{64}$/)
  const stored=h.storage.get(STORAGE_PREFIX+encodeURIComponent('user-a'))
  assert.equal(JSON.stringify(stored).includes('accessToken'),false)
  assert.equal(JSON.stringify(stored).includes('refreshToken'),false)
})

test('S-02 keeps an immutable failed batch and retries the exact idempotency payload', async () => {
  const h=harness((request,count)=>{
    if(count===1)throw Object.assign(new Error('offline'),{retryable:true,kind:'network'})
    return response(request)
  })
  h.manager.activate('user-a',{sync:false})
  const advanced=localEntry({checkpointSeconds:9,listenedRanges:[[0,9]],updatedAt:'2026-09-29T01:02:00.000Z'})
  h.manager.record(advanced,'peter-rabbit-01',false)
  assert.equal(await h.manager.trigger('test',false),false)
  assert.equal(h.manager._inspect().queue.length,1)
  assert.equal(h.scheduled.at(-1).delay,1000)

  await h.manager.trigger('retry',false)
  assert.equal(h.requests.length,2)
  assert.deepEqual(h.requests[1],h.requests[0])
  assert.equal(h.manager._inspect().queue.length,0)
})

test('S-02 storage and cursors remain isolated between signed-in accounts', async () => {
  const h=harness(request=>response(request,{nextCursor:'s02-cursor-v1:7:'+'b'.repeat(64)}))
  h.manager.activate('user-a',{sync:false})
  const advanced=localEntry({checkpointSeconds:7,listenedRanges:[[0,7]]})
  h.manager.record(advanced,'peter-rabbit-01',false)
  await h.manager.trigger('test',false)
  assert.match(h.manager._inspect().cursor,/s02-cursor-v1:7:/)

  h.setUser('user-b');h.manager.activate('user-b',{sync:false})
  assert.equal(h.manager._inspect().cursor,null)
  assert.deepEqual(h.manager._inspect().pieces,{})
  assert.equal([...h.storage.keys()].some(key=>key.endsWith('user-a')),true)
})

test('S-02 applies authoritative remote state without controlling active playback', async () => {
  const h=harness(request=>response(request,{changes:[{
    pieceId:'peter-rabbit-01',contentVersion:1,durationMs:20000,revision:'9',checkpointMs:12000,
    listenedRangesMs:[[0,12000]],listenedMs:12000,coverage:.6,completed:false,
    naturalEndObserved:false,serverUpdatedAt:'2026-09-29T02:00:00.000Z'
  }]}))
  h.manager.activate('user-a',{sync:false})
  await h.manager.trigger('foreground',true)
  assert.equal(h.remote.length,1)
  assert.equal(h.remote[0].revision,'9')
  assert.equal(h.manager._inspect().pieces['peter-rabbit-01'].checkpointMs,12000)
  assert.equal(h.manager.record(localEntry({checkpointSeconds:8,listenedRanges:[[0,8]]}),'peter-rabbit-01',false),false,'active playback must not regress a newer remote checkpoint')
})

test('S-02 preserves queued evidence when authentication expires', async () => {
  const h=harness(()=>{throw Object.assign(new Error('expired'),{retryable:false,kind:'unauthorized'})})
  h.manager.activate('user-a',{sync:false})
  h.manager.record(localEntry({checkpointSeconds:9,listenedRanges:[[0,9]]}),'peter-rabbit-01',false)
  assert.equal(await h.manager.trigger('test',false),false)
  assert.equal(h.manager._inspect().queue.length,1)
  assert.equal(h.manager.status().error,'authentication')
})

test('S-02 quarantines terminal evidence instead of resubmitting it forever', async () => {
  const h=harness(request=>response(request,{operations:request.operations.map(operation=>({operationId:operation.operationId,pieceId:operation.pieceId,status:'rejected',checkpointDecision:'not_applicable',clockStatus:'ok',reason:'content_version_unavailable',progress:null}))}))
  h.manager.activate('user-a',{sync:false})
  const incompatible=localEntry({checkpointSeconds:9,listenedRanges:[[0,9]]})
  h.manager.record(incompatible,'peter-rabbit-01',false)
  await h.manager.trigger('test',false)
  assert.equal(h.manager._inspect().terminal.length,1)
  assert.equal(h.manager.record(incompatible,'peter-rabbit-01',false),false)
})
