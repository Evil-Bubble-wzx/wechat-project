const test=require('node:test'),assert=require('node:assert/strict')
const points=require('../miniprogram/modules/ranking/learning-points')
const {createPage}=require('../miniprogram/ui/controller')
const api=require('../miniprogram/services/api')
const host=require('../miniprogram/services/host')
const quizSync=require('../miniprogram/modules/sync/quiz-sync')
const fixture=id=>({schemaVersion:1,attemptId:id,workId:'work',pieceId:'piece',contentVersion:1,quizVersion:1,questionIds:['q1'],selectedOptions:[0],startedAt:'2026-10-10T00:00:00Z',submittedAt:'2026-10-10T00:01:00Z',title:'Test',status:'local_unverified',score:0,mastery:false})
test('learning points preserve unlimited integer strings without Number coercion',()=>{
  assert.equal(points.formatPoints('900719925474099312345678901'),'900,719,925,474,099,312,345,678,901')
  assert.equal(points.formatPoints('1001'),'1,001')
  for(const value of ['-1','01','1.2',NaN,9007199254740992])assert.equal(points.formatPoints(value),'—')
})

test('late Quiz replies cannot update a different account or its page',async()=>{
  const originalWx=global.wx,originalScope=host.accountScope(),storage=new Map()
  const original={available:api.available,isAuthenticated:api.isAuthenticated,currentUser:api.currentUser,submitQuiz:api.submitQuiz}
  global.wx={isBrowserPreview:true,__tingyueMode:'production',getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value)}
  let activeUser='account-a',resolve,reject
  api.available=()=>true;api.isAuthenticated=()=>true;const users={'account-a':{userId:'account-a'},'account-b':{userId:'account-b'}};api.currentUser=()=>users[activeUser]
  api.submitQuiz=()=>new Promise((yes,no)=>{resolve=yes;reject=no})
  try{
    host.setAccountScope(activeUser)
    const attempt=fixture('quiz-account-a')
    host.write({results:[attempt]})
    const page=createPage('quiz');page.setData=patch=>Object.assign(page.data,patch)
    const pending=page.submitQuizAttempt(attempt)
    activeUser='account-b';host.setAccountScope(activeUser);host.write({results:[],learningScoreSummary:{ruleVersion:points.RULE_VERSION,totalPoints:'2',asOf:'2026-10-10T00:00:00Z'}})
    resolve({attemptId:'quiz-account-a',status:'server_verified',score:100,mastery:true,verifiedAt:'2026-10-10T00:01:00Z',learningScore:{ruleVersion:points.RULE_VERSION,totalPoints:'9999',asOf:'2026-10-10T01:00:00Z'}})
    await pending
    assert.equal(host.read().learningScoreSummary.totalPoints,'2');assert.deepEqual(host.read().results,[]);assert.equal(page.data.quizResultStatus,'')
    activeUser='account-a';host.setAccountScope(activeUser)
    const failed=page.submitQuizAttempt(attempt)
    activeUser='account-b';host.setAccountScope(activeUser);reject(new Error('late failure'));await failed
    assert.equal(page.data.quizResultStatus,'')
  }finally{quizSync.deactivate();Object.assign(api,original);host.setAccountScope(originalScope);global.wx=originalWx}
})

test('a current-account Quiz reply merges only its result and confirmed score',async()=>{
  const originalWx=global.wx,originalScope=host.accountScope(),storage=new Map()
  const original={available:api.available,isAuthenticated:api.isAuthenticated,currentUser:api.currentUser,submitQuiz:api.submitQuiz}
  global.wx={isBrowserPreview:true,__tingyueMode:'production',getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value)}
  api.available=()=>true;api.isAuthenticated=()=>true;const current={userId:'account-a'};api.currentUser=()=>current
  const attempt=fixture('quiz-current')
  api.submitQuiz=async()=>({attemptId:'quiz-current',status:'server_verified',score:100,mastery:true,verifiedAt:'2026-10-10T00:01:00Z',learningScore:{ruleVersion:points.RULE_VERSION,totalPoints:'9007199254740993123',asOf:'2026-10-10T01:00:00Z'}})
  try{
    host.setAccountScope('account-a');host.write({results:[attempt],words:['preserved']})
    const page=createPage('quiz');page.setData=patch=>Object.assign(page.data,patch)
    await page.submitQuizAttempt(attempt)
    assert.equal(host.read().learningScoreSummary.totalPoints,'9007199254740993123')
    assert.deepEqual(host.read().words,['preserved']);assert.equal(host.read().results[0].status,'server_verified')
  }finally{Object.assign(api,original);host.setAccountScope(originalScope);global.wx=originalWx}
})
test('confirmed score requires v2, prevents stale replies and never presents guest data as ranked',()=>{
  const state={}
  points.applyConfirmed(state,{ruleVersion:points.RULE_VERSION,totalPoints:'1250',asOf:'2026-10-09T09:00:00Z'})
  points.applyConfirmed(state,{ruleVersion:points.RULE_VERSION,totalPoints:'10',asOf:'2026-10-09T08:00:00Z'})
  assert.equal(state.learningScoreSummary.totalPoints,'1250')
  assert.equal(points.view(state,true).learningPoints,'1,250')
  assert.equal(points.view(state,false).learningPoints,'—')
  state.progressSyncOutbox={pending:{}}
  assert.match(points.view(state,true).learningPointsLabel,/待同步/)
})
test('ranking frontend exposes year and formats real point components without a maximum',async()=>{
  const original={available:api.available,isAuthenticated:api.isAuthenticated,rankingOptions:api.rankingOptions}
  api.available=()=>true;api.isAuthenticated=()=>true
  api.rankingOptions=async()=>({campuses:[{value:'a',label:'A校区'}],periodTypes:[{value:'year',label:'年榜'}],periods:{},scoreRules:{listening:{label:'有效听读',pointsPerUnit:'1',unit:'秒'}}})
  try{const view=createPage('ranking');view.setData=patch=>Object.assign(view.data,patch);await view.loadRankingOptions();assert.equal(view.data.rankingTypes[0].id,'year');assert.match(view.data.rankingRuleSummary,/每秒 \+1分/)}finally{Object.assign(api,original)}
})

test('a newer confirmed score may decrease after withdrawal',()=>{
  const state={}
  points.applyConfirmed(state,{ruleVersion:points.RULE_VERSION,totalPoints:'20',asOf:'2026-10-10T08:00:00Z'})
  points.applyConfirmed(state,{ruleVersion:points.RULE_VERSION,totalPoints:'10',asOf:'2026-10-10T09:00:00Z'})
  assert.equal(state.learningScoreSummary.totalPoints,'10')
})

test('late quiz success or failure cannot mutate another account or a replacement session',async()=>{
  const original={available:api.available,isAuthenticated:api.isAuthenticated,currentUser:api.currentUser,submitQuiz:api.submitQuiz}
  const quizSync=require('../miniprogram/modules/sync/quiz-sync'),queueOriginal={activate:quizSync.activate,enqueue:quizSync.enqueue,trigger:quizSync.trigger}
  quizSync.activate=()=>true;quizSync.enqueue=()=>true
  const mutate=host.mutate,scope=host.accountScope
  let user={userId:'user-a'},activeScope='user-a',resolve,reject,writes=0,updates=0
  api.available=()=>true;api.isAuthenticated=()=>true;api.currentUser=()=>user
  host.accountScope=()=>activeScope;host.mutate=()=>{writes++}
  const page=createPage('quiz');page.setData=()=>{updates++}
  try {
    for(const failure of [false,true]) {
      user={userId:'user-a'};activeScope='user-a'
      quizSync.trigger=()=>new Promise((yes,no)=>{resolve=yes;reject=no})
      const pending=page.submitQuizAttempt({attemptId:'attempt-a'})
      user={userId:'user-b'};activeScope='user-b'
      resolve({status:'server_verified'})
      await pending
    }
    user={userId:'user-a'};activeScope='user-a'
    quizSync.trigger=()=>new Promise(yes=>{resolve=yes})
    const pending=page.submitQuizAttempt({attemptId:'attempt-a'})
    user={userId:'user-a'} // logout/login as the same user is a new session
    resolve({status:'server_verified'});await pending
    assert.equal(writes,0);assert.equal(updates,0)
  } finally {Object.assign(quizSync,queueOriginal);Object.assign(api,original);host.mutate=mutate;host.accountScope=scope}
})
