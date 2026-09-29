const { test } = require('node:test')
const assert = require('node:assert/strict')

function harness() {
  const previousWx=global.wx,stored={}
  global.wx={isBrowserPreview:false,getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getExtConfigSync:()=>({apiBaseUrl:'https://api.test.invalid'}),getStorageSync:key=>stored[key],setStorageSync:(key,value)=>{stored[key]=value},request(){}}
  for(const path of ['../miniprogram/services/host','../miniprogram/services/api','../miniprogram/modules/sync/progress-sync'])delete require.cache[require.resolve(path)]
  const host=require('../miniprogram/services/host'),api=require('../miniprogram/services/api'),sync=require('../miniprogram/modules/sync/progress-sync')
  const originals={currentUser:api.currentUser,available:api.available,isAuthenticated:api.isAuthenticated,progressSyncAvailable:api.progressSyncAvailable,putProgress:api.putProgress,listProgress:api.listProgress,getProgress:api.getProgress}
  api.currentUser=()=>({userId:'user-a'});api.available=()=>true;api.isAuthenticated=()=>true;api.progressSyncAvailable=()=>true
  host.setAccountScope('user-a')
  return {host,api,sync,stored,restore(){sync._resetForTests();Object.assign(api,originals);host.setAccountScope(null);global.wx=previousWx}}
}
const remote=(patch={})=>Object.assign({pieceId:'peter-rabbit-01',contentVersion:1,revision:'2',checkpointMs:6000,listenedRangesMs:[[0,6000]],listenedMs:6000,coverage:.6,completed:false,historicalVersion:false,serverUpdatedAt:'2026-09-29T08:00:00.000Z'},patch)

test('S-02 keeps guest and account learning spaces isolated',()=>{
  const h=harness()
  try{
    h.host.setAccountScope(null);h.host.write({progress:{guest:{checkpointSeconds:3}},favorites:[],recent:[],results:[],words:[]})
    h.host.setAccountScope('user-a');assert.deepEqual(h.host.read().progress,{})
    h.host.write({progress:{account:{checkpointSeconds:7}},favorites:[],recent:[],results:[],words:[]})
    h.host.setAccountScope('user-b');assert.deepEqual(h.host.read().progress,{})
    h.host.setAccountScope(null);assert.equal(h.host.read().progress.guest.checkpointSeconds,3)
  }finally{h.restore()}
})

test('S-02 captures progress and removes an exactly acknowledged mutation',async()=>{
  const h=harness()
  try{
    h.host.mutate(state=>h.sync.capture(state,'peter-rabbit-01',{contentVersion:1,checkpointSeconds:6,listenedRanges:[[0,6]]},{immediate:true}))
    const queued=Object.values(h.host.read().progressSyncOutbox)[0]
    assert.equal(queued.request.baseRevision,'0');assert.deepEqual(queued.request.listenedRangesMs,[[0,6000]])
    h.api.putProgress=async(_pieceId,request)=>({mutationId:request.mutationId,mergeStatus:'applied',checkpointAccepted:true,progress:remote(),acknowledgedAt:'2026-09-29T08:00:00.000Z'})
    await h.sync.flush()
    const state=h.host.read();assert.equal(Object.keys(state.progressSyncOutbox||{}).length,0);assert.equal(state.progress['peter-rabbit-01'].serverRevision,'2');assert.equal(h.sync.view(state).status,'synced')
  }finally{h.restore()}
})

test('S-02 preserves retryable writes and does not overwrite a stale checkpoint',async()=>{
  const h=harness()
  try{
    h.host.mutate(state=>h.sync.capture(state,'peter-rabbit-01',{contentVersion:1,checkpointSeconds:9,listenedRanges:[[0,9]]},{immediate:true}))
    h.api.putProgress=async()=>{throw Object.assign(new Error('offline'),{kind:'network',retryable:true})}
    await h.sync.flush();let state=h.host.read(),queued=Object.values(state.progressSyncOutbox)[0]
    assert.equal(queued.attempts,1);assert.equal(h.sync.view(state).status,'pending')
    queued.nextAttemptAt=0;h.host.write(state)
    h.api.putProgress=async(_pieceId,request)=>({mutationId:request.mutationId,mergeStatus:'merged_stale_base',checkpointAccepted:false,progress:remote({revision:'5',checkpointMs:4000,listenedRangesMs:[[0,9000]],listenedMs:9000,coverage:.9}),acknowledgedAt:'2026-09-29T08:01:00.000Z'})
    await h.sync.flush();state=h.host.read()
    assert.equal(state.progress['peter-rabbit-01'].checkpointSeconds,4);assert.equal(state.progress['peter-rabbit-01'].serverRevision,'5')
  }finally{h.restore()}
})

test('S-02 overlays pending local evidence on a pulled cloud baseline',()=>{
  const h=harness()
  try{
    const state={progress:{'peter-rabbit-01':{contentVersion:1,checkpointSeconds:8,listenedRanges:[[7,8]]}},progressSyncOutbox:{'peter-rabbit-01@1':{pieceId:'peter-rabbit-01',request:{contentVersion:1}}}}
    h.sync._applyRemote(state,remote())
    assert.equal(state.progress['peter-rabbit-01'].checkpointSeconds,8);assert.deepEqual(state.progress['peter-rabbit-01'].listenedRanges,[[0,6],[7,8]])
  }finally{h.restore()}
})
