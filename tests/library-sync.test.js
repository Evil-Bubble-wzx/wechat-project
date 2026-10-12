const test=require('node:test')
const assert=require('node:assert/strict')
const {createLibrarySyncManager,STORAGE_PREFIX}=require('../miniprogram/modules/sync/library-sync')
const entry=patch=>Object.assign({workId:'peter-rabbit',favorite:true,favoriteRevision:'1',lastOpenedAt:null,serverUpdatedAt:'2026-10-10T05:00:00.000Z'},patch)
const reply=(request,patch={})=>Object.assign({schemaVersion:1,batchId:request.batchId,serverTime:'2026-10-10T05:00:00.000Z',operations:request.operations.map(op=>({operationId:op.operationId,status:'applied',reason:null,entry:entry({favorite:op.action!=='unfavorite'})})),changes:[],nextCursor:'cursor-1',hasMore:false},patch)
function harness(handler,options={}){
  const storage=options.storage||new Map(),states=new Map(),requests=[],scheduled=[]
  let userId='user-a',authenticated=true
  const host={accountScope:()=>userId,read:()=>states.get(userId)||{},mutate:fn=>{const state=fn(host.read());states.set(userId,state);return state}}
  const manager=createLibrarySyncManager({
    runtime:{getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value)},
    api:{isAuthenticated:()=>authenticated,currentUser:()=>({userId}),librarySyncAvailable:()=>true},host,
    now:()=>Date.parse('2026-10-10T05:00:00.000Z'),random:()=>.5,
    schedule:(fn,delay)=>{const value={fn,delay};scheduled.push(value);return value},cancel:()=>{},
    submit:async request=>{requests.push(request);return handler(request,requests.length)}
  })
  return {manager,states,storage,requests,scheduled,host,setUser:id=>{userId=id},setAuthenticated:value=>{authenticated=value}}
}
test('library changes are account-scoped, optimistic and persisted without credentials',async()=>{
  const h=harness(request=>reply(request))
  assert.equal(h.manager.record('favorite','peter-rabbit'),false)
  h.manager.activate('user-a',{sync:false});h.manager.record('favorite','peter-rabbit',false)
  assert.deepEqual(h.host.read().favorites,['peter-rabbit'])
  await h.manager.trigger('test',false)
  assert.equal(h.requests.length,1);assert.match(h.requests[0].operations[0].operationId,/^library-op-v1:[a-f0-9]{64}$/)
  assert.equal(h.manager.status().status,'synced')
  assert.doesNotMatch(JSON.stringify(h.storage.get(STORAGE_PREFIX+'user-a')),/accessToken|refreshToken/)
  h.setUser('user-b');h.manager.activate('user-b',{sync:false});assert.deepEqual(h.host.read().favorites,[])
})
test('library retries the same immutable offline batch and survives process restart',async()=>{
  const storage=new Map(),first=harness(()=>{throw new Error('offline')},{storage})
  first.manager.activate('user-a',{sync:false});first.manager.record('unfavorite','peter-rabbit',false)
  await first.manager.trigger('test',false);assert.equal(first.scheduled[0].delay,1000)
  const next=harness(request=>reply(request),{storage});next.manager.activate('user-a',{sync:false});await next.manager.trigger('retry',false)
  assert.deepEqual(next.requests[0],first.requests[0]);assert.equal(next.manager._inspect().queue.length,0)
})
test('library empty pulls use a new batch identity when the cursor is unchanged',async()=>{
  const h=harness(request=>reply(request))
  h.manager.activate('user-a',{sync:false})
  await h.manager.trigger('pull',true);await h.manager.trigger('pull',true);await h.manager.trigger('pull',true)
  assert.equal(h.requests[1].cursor,h.requests[2].cursor)
  assert.notEqual(h.requests[1].batchId,h.requests[2].batchId)
})
test('library preserves a new unfavorite while an old favorite acknowledgement is in flight',async()=>{
  let release
  const h=harness((request,count)=>count===1?new Promise(resolve=>{release=()=>resolve(reply(request))}):reply(request,{changes:[entry({favorite:false,favoriteRevision:'2'})]}))
  h.manager.activate('user-a',{sync:false});h.manager.record('favorite','peter-rabbit',false)
  const pending=h.manager.trigger('send',false)
  h.manager.record('unfavorite','peter-rabbit',false);assert.deepEqual(h.host.read().favorites,[])
  release();await pending
  assert.equal(h.requests[1].operations[0].action,'unfavorite');assert.equal(h.requests[1].operations[0].baseRevision,'1');assert.deepEqual(h.host.read().favorites,[])
})
test('library discards late replies after account switch and retains the original queue',async()=>{
  let release
  const h=harness(request=>new Promise(resolve=>{release=()=>resolve(reply(request))}))
  h.manager.activate('user-a',{sync:false});h.manager.record('favorite','peter-rabbit',false);const pending=h.manager.trigger('send',false)
  h.setUser('user-b');h.manager.activate('user-b',{sync:false});release();assert.equal(await pending,false)
  assert.deepEqual(h.host.read().favorites,[]);assert.equal(h.storage.get(STORAGE_PREFIX+'user-a').queue.length,1)
})
test('library applies deletion tombstones and shows contract errors without discarding unsent intent',async()=>{
  let bad=false
  const h=harness(request=>bad?reply(request,{operations:[]}):reply(request,{changes:[entry({favorite:false,favoriteRevision:'3'})]}))
  h.manager.activate('user-a',{sync:false});await h.manager.trigger('pull',true);assert.deepEqual(h.host.read().favorites,[])
  bad=true;h.manager.record('favorite','peter-rabbit',false);await h.manager.trigger('test',false)
  assert.equal(h.manager.status().error,'contract');assert.equal(h.manager._inspect().queue.length,1);assert.equal(h.requests.at(-1).operations[0].baseRevision,'3')
})
test('library recent reading order merges server visits and queued offline visits',async()=>{
  const h=harness(request=>reply(request,{changes:[entry({workId:'one',favorite:false,lastOpenedAt:'2026-10-09T05:00:00.000Z'}),entry({workId:'two',favorite:false,lastOpenedAt:'2026-10-08T05:00:00.000Z'})]}))
  h.manager.activate('user-a',{sync:false});await h.manager.trigger('pull',true);assert.deepEqual(h.host.read().recent,['one','two'])
  h.manager.record('open','two',false);assert.deepEqual(h.host.read().recent,['two','one'])
})

test('library does not erase local favorites against an older server contract',()=>{
  let state={favorites:['peter-rabbit'],recent:['peter-rabbit']}
  const manager=createLibrarySyncManager({api:{isAuthenticated:()=>true,currentUser:()=>({userId:'a'}),librarySyncAvailable:()=>false},host:{accountScope:()=> 'a',read:()=>state,mutate:fn=>{state=fn(state);return state}}})
  assert.equal(manager.activate('a',{sync:false}),false);manager.foreground()
  assert.deepEqual(state.favorites,['peter-rabbit']);assert.deepEqual(state.recent,['peter-rabbit'])
})
