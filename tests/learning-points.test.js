const test=require('node:test'),assert=require('node:assert/strict')
const points=require('../miniprogram/modules/ranking/learning-points')
const {createPage}=require('../miniprogram/ui/controller')
const api=require('../miniprogram/services/api')
const host=require('../miniprogram/services/host')
test('learning points preserve unlimited integer strings without Number coercion',()=>{
  assert.equal(points.formatPoints('900719925474099312345678901'),'900,719,925,474,099,312,345,678,901')
  assert.equal(points.formatPoints('1001'),'1,001')
  for(const value of ['-1','01','1.2',NaN,9007199254740992])assert.equal(points.formatPoints(value),'—')
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
  const mutate=host.mutate,scope=host.accountScope
  let user={userId:'user-a'},activeScope='user-a',resolve,reject,writes=0,updates=0
  api.available=()=>true;api.isAuthenticated=()=>true;api.currentUser=()=>user
  host.accountScope=()=>activeScope;host.mutate=()=>{writes++}
  const page=createPage('quiz');page.setData=()=>{updates++}
  try {
    for(const failure of [false,true]) {
      user={userId:'user-a'};activeScope='user-a'
      api.submitQuiz=()=>new Promise((yes,no)=>{resolve=yes;reject=no})
      const pending=page.submitQuizAttempt({attemptId:'attempt-a'})
      user={userId:'user-b'};activeScope='user-b'
      if(failure)reject(new Error('late failure'));else resolve({status:'server_verified'})
      await pending
    }
    user={userId:'user-a'};activeScope='user-a'
    api.submitQuiz=()=>new Promise(yes=>{resolve=yes})
    const pending=page.submitQuizAttempt({attemptId:'attempt-a'})
    user={userId:'user-a'} // logout/login as the same user is a new session
    resolve({status:'server_verified'});await pending
    assert.equal(writes,0);assert.equal(updates,0)
  } finally {Object.assign(api,original);host.mutate=mutate;host.accountScope=scope}
})
