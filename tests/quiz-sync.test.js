const test=require('node:test'),assert=require('node:assert/strict')
const {createQuizSyncManager,STORAGE_PREFIX}=require('../miniprogram/modules/sync/quiz-sync')
const cloudView=require('../miniprogram/modules/report/cloud-view')
const clone=value=>JSON.parse(JSON.stringify(value))
const at='2026-10-10T01:00:00.000Z'
const attempt=(id='quiz-attempt-001')=>({schemaVersion:1,attemptId:id,workId:'book',pieceId:'piece',contentVersion:1,quizVersion:1,questionIds:['q1'],selectedOptions:[0],startedAt:at,submittedAt:at,status:'local_unverified',score:100,mastery:true,title:'Test'})
const entry=(status='server_verified',revision='1')=>({schemaVersion:1,attemptId:'quiz-attempt-001',workId:'book',pieceId:'piece',title:'Test',contentVersion:1,quizVersion:1,startedAt:at,submittedAt:at,verifiedAt:at,status,score:status==='server_verified'?100:null,mastery:status==='server_verified'?true:null,questionCount:1,correctCount:1,currentCompatible:true,rejectionCode:null,revision,serverUpdatedAt:at})
const summary=(overrides={})=>Object.assign({schemaVersion:1,source:'server_verified',asOf:at,completedPieces:1,completedWords:'100',knownCompletedWords:'100',unknownWordPieces:0,listenedMs:'10000',verifiedAttemptCount:1,compatibleQuizPieces:1,averageCorrectPercent:100,trend:{ready:false,remaining:5,early:null,recent:null,delta:null,pieceCount:1},learningScore:{ruleVersion:'learning-points-v2',totalPoints:'70',asOf:at}},overrides)
function fixture(options={}){
  let id='account-a',authenticated=true
  const storage=options.storage||new Map(),states=new Map([['account-a',{results:[]}],['account-b',{results:[]}]])
  const timers=[],sent=[]
  const host={accountScope:()=>id,read:()=>states.get(id),mutate:fn=>{const next=fn(states.get(id));states.set(id,next);return next}}
  const runtime={getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,clone(value)),onNetworkStatusChange:fn=>{runtime.network=fn}}
  const api={isAuthenticated:()=>authenticated,currentUser:()=>({userId:id}),quizHistoryAvailable:()=>true,
    submitQuiz:async request=>{sent.push(clone(request));return {attemptId:request.attemptId,status:'server_verified',score:100,mastery:true,verifiedAt:at}},
    quizHistory:async()=>({schemaVersion:1,changes:[entry()],nextCursor:'cursor-1',hasMore:false}),
    learningSummary:async()=>summary()}
  Object.assign(api,options.api)
  const make=()=>createQuizSyncManager({api,host,runtime,schedule:(fn,delay)=>{timers.push({fn,delay});return timers.length},cancel:()=>{}})
  const manager=make();manager.activate(id,{sync:false})
  return {manager,make,host,api,storage,sent,timers,runtime,setUser:value=>{id=value},setAuth:value=>{authenticated=value},states}
}
test('Quiz persists immutable answers before transmission and survives offline restart',async()=>{
  const f=fixture(),original=attempt()
  f.host.mutate(state=>Object.assign(state,{results:[original],words:['preserved']}))
  let offline=true
  f.api.submitQuiz=async request=>{f.sent.push(clone(request));assert.ok(f.storage.get(STORAGE_PREFIX+'account-a').queue.length);if(offline)throw Object.assign(Error('offline'),{retryable:true});return {attemptId:request.attemptId,status:'server_verified',score:100,mastery:true,verifiedAt:at}}
  assert.equal(f.manager.enqueue(original,false),true);original.selectedOptions[0]=2
  assert.equal(await f.manager.trigger('offline',true),false);assert.equal(f.manager.status().pendingCount,1);assert.equal(f.timers[0].delay,1000)
  f.manager.deactivate();offline=false
  const restarted=f.make();restarted.activate('account-a',{sync:false})
  assert.equal(await restarted.trigger('retry',true),true)
  assert.deepEqual(f.sent[0],f.sent[1]);assert.deepEqual(f.sent[1].selectedOptions,[0]);assert.equal('score' in f.sent[1],false);assert.equal('mastery' in f.sent[1],false)
  assert.equal(restarted.status().pendingCount,0);assert.deepEqual(f.host.read().words,['preserved'])
  restarted.deactivate()
})
test('Quiz does not acknowledge malformed or incomplete verification responses',async()=>{
  for(const response of [{attemptId:'other',status:'server_verified',score:100,mastery:true,verifiedAt:at},{attemptId:'quiz-attempt-001',status:'server_verified',score:100},{attemptId:'quiz-attempt-001',status:'rejected',error:{code:'NO',retryable:true}}]){
    const f=fixture({api:{submitQuiz:async()=>response}})
    f.manager.enqueue(attempt(),false);assert.equal(await f.manager.trigger('bad',false),false)
    assert.equal(f.manager.status().error,'contract');assert.equal(f.manager.status().pendingCount,1);assert.equal(f.timers.length,0)
    f.manager.deactivate()
  }
})
test('Quiz confirmed rejection retains local answers but leaves the outbox',async()=>{
  const f=fixture({api:{submitQuiz:async request=>({attemptId:request.attemptId,status:'rejected',error:{code:'QUIZ_PACKAGE_MISMATCH',retryable:false}})}})
  f.host.mutate(state=>Object.assign(state,{results:[attempt()]}))
  f.manager.enqueue(attempt(),false);await f.manager.trigger('reject',false)
  assert.equal(f.manager.status().pendingCount,0);assert.equal(f.host.read().results[0].status,'rejected');assert.deepEqual(f.host.read().results[0].selectedOptions,[0])
  f.manager.deactivate()
})
test('Quiz late acknowledgement cannot mutate another account and preserves original queue',async()=>{
  const f=fixture();let resolve
  f.api.submitQuiz=()=>new Promise(done=>{resolve=done})
  f.host.mutate(state=>Object.assign(state,{results:[attempt()]}))
  f.manager.enqueue(attempt(),false);const pending=f.manager.trigger('send',false)
  f.setUser('account-b');f.manager.activate('account-b',{sync:false})
  resolve({attemptId:'quiz-attempt-001',status:'server_verified',score:100,mastery:true,verifiedAt:at})
  assert.equal(await pending,false);assert.deepEqual(f.host.read().results,[]);assert.equal(f.storage.get(STORAGE_PREFIX+'account-a').queue.length,1)
  f.manager.deactivate()
})
test('Quiz migrates only current-account unverified attempts, not guest or legacy data',()=>{
  const f=fixture();f.host.mutate(state=>Object.assign(state,{results:[attempt(),{title:'legacy',score:100}]}))
  f.manager.deactivate();f.manager.activate('account-a',{sync:false})
  assert.equal(f.manager._inspect().queue.length,1)
  f.setAuth(false);assert.equal(f.manager.enqueue(attempt('quiz-guest'),false),false)
  f.manager.foreground();assert.equal(f.manager.status().pendingCount,0)
})
test('cloud Quiz history pages merge by decimal revision and withdrawals override cached scores',async()=>{
  const f=fixture();f.host.mutate(state=>Object.assign(state,{results:[Object.assign(attempt(),{status:'server_verified'})]}))
  let phase=0
  f.api.quizHistory=async cursor=>phase===0?{schemaVersion:1,changes:[entry('server_verified','9007199254740993')],nextCursor:'page-one',hasMore:true}:phase===1?{schemaVersion:1,changes:[entry('withdrawn','9007199254740994')],nextCursor:'page-two',hasMore:false}:{schemaVersion:1,changes:[entry('server_verified','9007199254740993')],nextCursor:'page-three',hasMore:false}
  const original=f.api.quizHistory;f.api.quizHistory=async cursor=>{const result=await original(cursor);phase++;return result}
  assert.equal(await f.manager.trigger('history',true),true)
  assert.equal(f.host.read().cloudQuizHistory[0].status,'withdrawn');assert.equal(f.host.read().results[0].status,'rejected')
  await f.manager.trigger('old-page',true);assert.equal(f.host.read().cloudQuizHistory[0].status,'withdrawn')
  assert.equal(cloudView.view(f.host.read()).results[0].scoreLabel,'—');f.manager.deactivate()
})
test('invalid cloud cursor causes an atomic full repull, keeping old cache on partial failure',async()=>{
  const f=fixture();await f.manager.trigger('initial',true)
  let requests=0
  f.api.quizHistory=async cursor=>{
    requests++
    if(cursor==='cursor-1')throw Object.assign(Error('old epoch'),{serverCode:'INVALID_REQUEST',statusCode:400,retryable:false})
    if(cursor===null)return {schemaVersion:1,changes:[entry('withdrawn','2')],nextCursor:'reset-page',hasMore:true}
    throw Object.assign(Error('offline'),{retryable:true})
  }
  assert.equal(await f.manager.trigger('reset',true),false);assert.equal(requests,3)
  assert.equal(f.host.read().cloudQuizHistory[0].status,'server_verified');assert.equal(f.manager._inspect().cursor,'cursor-1')
  f.api.quizHistory=async cursor=>{
    if(cursor==='cursor-1')throw Object.assign(Error('old epoch'),{serverCode:'INVALID_REQUEST',statusCode:400,retryable:false})
    return {schemaVersion:1,changes:[entry('withdrawn','2')],nextCursor:'reset-complete',hasMore:false}
  }
  assert.equal(await f.manager.trigger('retry-reset',true),true);assert.equal(f.host.read().cloudQuizHistory[0].status,'withdrawn')
  f.manager.deactivate()
})
test('cloud summary failures preserve confirmed caches and reject stale summary timestamps',async()=>{
  const f=fixture();await f.manager.trigger('initial',true)
  f.api.learningSummary=async()=>summary({asOf:'2026-10-09T00:00:00Z',completedPieces:999})
  await f.manager.trigger('stale',true);assert.equal(f.host.read().cloudLearningSummary.completedPieces,1)
  f.api.learningSummary=async()=>{throw Object.assign(Error('offline'),{retryable:true})}
  assert.equal(await f.manager.trigger('offline',true),false);assert.equal(f.host.read().cloudLearningSummary.completedPieces,1)
  f.manager.deactivate()
})
test('cloud reports never use unverified local scores as authoritative statistics',()=>{
  const local={results:[attempt()]}
  const view=cloudView.view(local)
  assert.equal(view.stats.correctLabel,'—');assert.equal(view.stats.pieces,'—');assert.equal(view.results.length,1)
  const verified=cloudView.view({results:[attempt()],cloudLearningSummary:summary({averageCorrectPercent:40})})
  assert.equal(verified.stats.correctLabel,'40%');assert.equal(verified.results[0].status,'local_unverified')
  assert.equal(cloudView.view({cloudLearningSummary:summary({completedWords:null,unknownWordPieces:1})}).stats.words,'—')
})
test('cloud listening and word counts retain integer-string precision',()=>{
  assert.equal(cloudView.listeningLabel('3661000'),'01:01')
  assert.equal(cloudView.listeningLabel('9007199254740993123456000'),'2501999792983609200:57')
  const view=cloudView.view({cloudLearningSummary:summary({completedWords:'9007199254740993123456',knownCompletedWords:'9007199254740993123456'})})
  assert.equal(view.stats.words,'9007199254740993123456')
})
test('same Quiz attempt identity cannot be queued with changed answers',()=>{
  const f=fixture(),original=attempt()
  assert.equal(f.manager.enqueue(original,false),true)
  assert.equal(f.manager.enqueue(Object.assign({},original,{selectedOptions:[1]}),false),false)
  assert.deepEqual(f.manager._inspect().queue[0].selectedOptions,[0]);f.manager.deactivate()
})
test('network restoration restarts account-scoped Quiz synchronization',async()=>{
  const f=fixture();f.manager.start();let submissions=0
  f.api.submitQuiz=async request=>{submissions++;return {attemptId:request.attemptId,status:'server_verified',score:100,mastery:true,verifiedAt:at}}
  f.manager.enqueue(attempt(),false);f.runtime.network({isConnected:true})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(submissions,1);assert.equal(f.manager.status().pendingCount,0);f.manager.deactivate()
})

test('late cloud history reply cannot overwrite the new account cache',async()=>{
  const f=fixture();let resolve
  f.api.quizHistory=()=>new Promise(done=>{resolve=done})
  const pending=f.manager.trigger('pull-a',true)
  f.setUser('account-b');f.manager.activate('account-b',{sync:false})
  resolve({schemaVersion:1,changes:[entry()],nextCursor:'a-only',hasMore:false})
  assert.equal(await pending,false);assert.deepEqual(f.host.read().cloudQuizHistory,[]);assert.equal(f.host.read().cloudLearningSummary,null)
  f.manager.deactivate()
})
test('authenticated report and Me controller use the same trusted summary, not local feedback',()=>{
  const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host'),{createPage}=require('../miniprogram/ui/controller')
  const originalWx=global.wx,originalScope=host.accountScope(),original={isAuthenticated:api.isAuthenticated,currentUser:api.currentUser}
  const storage=new Map()
  global.wx={isBrowserPreview:true,__tingyueMode:'production',getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,clone(value))}
  api.isAuthenticated=()=>true;api.currentUser=()=>({userId:'cloud-report-account'})
  try{
    host.setAccountScope('cloud-report-account')
    host.write({results:[attempt()],progress:{piece:{completed:true}},listeningSec:99999,cloudLearningSummary:summary({averageCorrectPercent:40}),cloudQuizHistory:[entry()]})
    for(const route of ['me','report']){
      const page=createPage(route);page.setData=patch=>Object.assign(page.data,patch);page.refresh()
      assert.equal(page.data.stats.correctLabel,'40%');assert.equal(page.data.stats.pieces,1);assert.equal(page.data.stats.words,'100');assert.equal(page.data.stats.listening,'00:10')
      assert.match(page.data.reportSourceLabel,/云端验真/);assert.equal(page.data.results.length,1)
    }
    host.setAccountScope('another-account');assert.equal(host.read().cloudLearningSummary,undefined)
  }finally{Object.assign(api,original);host.setAccountScope(originalScope);global.wx=originalWx}
})

test('Quiz storage failures prevent network send and corrupt queues are preserved',async()=>{
  const f=fixture(),write=f.runtime.setStorageSync
  f.host.mutate(state=>Object.assign(state,{results:[attempt()]}))
  f.runtime.setStorageSync=()=>{throw Error('quota')}
  assert.equal(f.manager.enqueue(attempt(),false),false)
  assert.equal(await f.manager.trigger('quota-retry',false),false);assert.equal(f.sent.length,0);assert.equal(f.timers.length,0)
  f.runtime.setStorageSync=write;assert.equal(await f.manager.trigger('space-restored',true),true);assert.equal(f.sent.length,1)
  f.manager.deactivate()
  const damaged={schemaVersion:1,userId:'account-a',queue:[{attemptId:'damaged'}],history:{},cursor:null,summary:null}
  f.storage.set(STORAGE_PREFIX+'account-a',clone(damaged))
  assert.equal(f.manager.activate('account-a',{sync:false}),false);assert.equal(f.manager.enqueue(attempt(),false),false)
  assert.deepEqual(f.storage.get(STORAGE_PREFIX+'account-a'),damaged);f.manager.deactivate()
})
test('cloud history treats prototype-like attempt IDs as ordinary records',async()=>{
  const f=fixture(),changes=['__proto__','constructor'].map((attemptId,index)=>Object.assign(entry('server_verified',String(index+1)),{attemptId}))
  f.api.quizHistory=async()=>({schemaVersion:1,changes,nextCursor:'safe-dictionary',hasMore:false})
  assert.equal(await f.manager.trigger('special-ids',true),true)
  assert.deepEqual(f.host.read().cloudQuizHistory.map(item=>item.attemptId).sort(),['__proto__','constructor'])
  f.manager.deactivate();assert.equal(f.manager.activate('account-a',{sync:false}),true)
  assert.equal(f.host.read().cloudQuizHistory.length,2);f.manager.deactivate()
})
