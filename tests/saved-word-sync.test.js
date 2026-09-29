const test = require('node:test')
const assert = require('node:assert/strict')

const { createSavedWordSyncManager, STORAGE_PREFIX } = require('../miniprogram/modules/sync/saved-word-sync')

const word = overrides => Object.assign({
  entryId:'ve-5732b4cca2b4',pieceId:'peter-rabbit-01',contentVersion:1,
  vocabKey:'a:determiner:1',surface:'a',lemma:'a'
},overrides)

function response(request,overrides={}){return Object.assign({schemaVersion:1,batchId:request.batchId,serverTime:'2026-09-29T02:00:00.000Z',operations:[],changes:[],nextCursor:'s03-word-cursor-v1:0:'+'a'.repeat(64),hasMore:false},overrides)}
function harness(handler){
  const storage=new Map(),requests=[],remote=[],scheduled=[];let userId='user-a',authenticated=true
  const manager=createSavedWordSyncManager({
    runtime:{getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value)},api:{},host:{},
    random:()=>0,now:()=>Date.parse('2026-09-29T02:00:00.000Z'),schedule:(fn,delay)=>{const timer={fn,delay};scheduled.push(timer);return timer},cancel:()=>{},
    isAuthenticated:()=>authenticated,currentUser:()=>({userId}),applyRemote:value=>remote.push(value),
    submit:async request=>{requests.push(request);return handler(request,requests.length)}
  })
  return {manager,storage,requests,remote,scheduled,setUser:value=>{userId=value},setAuthenticated:value=>{authenticated=value}}
}

test('S-03 queues stable word entries only after an authenticated explicit mutation', async()=>{
  const h=harness(request=>response(request))
  assert.equal(h.manager.saveWord(word()),false)
  h.manager.activate('user-a',{sync:false})
  assert.equal(h.manager.saveWord(word()),true)
  await h.manager.trigger('test',false)
  assert.equal(h.requests.length,1)
  assert.equal(h.requests[0].operations[0].action,'save')
  assert.match(h.requests[0].operations[0].operationId,/^s03-word-op-v1:[a-f0-9]{64}$/)
  assert.match(h.requests[0].batchId,/^s03-word-batch-v1:[a-f0-9]{64}$/)
  const stored=h.storage.get(STORAGE_PREFIX+encodeURIComponent('user-a'))
  assert.equal(JSON.stringify(stored).includes('accessToken'),false)
})

test('S-03 replays an immutable offline batch with the same idempotency IDs', async()=>{
  const h=harness((request,count)=>{if(count===1)throw Object.assign(new Error('offline'),{retryable:true,kind:'network'});return response(request)})
  h.manager.activate('user-a',{sync:false});h.manager.saveWord(word(),false)
  assert.equal(await h.manager.trigger('test',false),false)
  assert.equal(h.scheduled.at(-1).delay,1000)
  await h.manager.trigger('retry',false)
  assert.deepEqual(h.requests[1],h.requests[0])
})

test('S-03 applies saved words and deletion tombstones without mixing accounts', async()=>{
  const saved=word({revision:'2',state:'saved',serverUpdatedAt:'2026-09-29T02:00:00.000Z'})
  const deleted=word({revision:'3',state:'deleted',serverUpdatedAt:'2026-09-29T02:01:00.000Z'})
  let pull=0
  const h=harness(request=>response(request,{changes:[pull++?deleted:saved],nextCursor:'s03-word-cursor-v1:'+pull+':'+'b'.repeat(64)}))
  h.manager.activate('user-a',{sync:false});await h.manager.trigger('pull',true)
  assert.equal(h.remote[0].state,'saved')
  await h.manager.trigger('pull',true)
  assert.equal(h.remote[1].state,'deleted')
  h.setUser('user-b');h.manager.activate('user-b',{sync:false})
  assert.equal(h.manager._inspect().cursor,null)
  assert.deepEqual(h.manager._inspect().words,{})
})

test('S-03 sends delete against the last server revision and preserves auth failures', async()=>{
  let phase='pull'
  const remote=word({revision:'7',state:'saved',serverUpdatedAt:'2026-09-29T02:00:00.000Z'})
  const h=harness(request=>{
    if(phase==='pull')return response(request,{changes:[remote]})
    throw Object.assign(new Error('expired'),{retryable:false,kind:'unauthorized'})
  })
  h.manager.activate('user-a',{sync:false});await h.manager.trigger('pull',true);phase='delete'
  h.manager.deleteWord(word())
  await new Promise(resolve=>setImmediate(resolve))
  const queued=h.manager._inspect().queue[0]
  assert.equal(queued.operations[0].baseRevision,'7')
  assert.equal(queued.operations[0].action,'delete')
  assert.equal(h.manager.status().error,'authentication')
  assert.equal(h.manager._inspect().queue.length,1)
})
