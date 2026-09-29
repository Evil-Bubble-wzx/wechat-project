const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendApi } = require('../miniprogram/services/api')

function fixture(responder) {
  const calls=[]
  const stored=new Map()
  const runtime={
    login:({success})=>success({code:'real-wechat-code'}),
    getStorageSync:key=>stored.get(key),
    setStorageSync:(key,value)=>stored.set(key,value)
  }
  const api=createBackendApi({
    runtime,
    configuration:{enabled:true,apiRoot:'https://api.test.invalid/api/v1',development:true,stubLoginCode:'test:miniapp-develop',contractVersion:'api-contract-v1.3.0'},
    transport:async request=>{calls.push(request);return responder(request,calls)},
    makeId:prefix=>prefix+'-fixed',
    sleep:async()=>{},
    random:()=>0
  })
  return {api,calls,stored}
}

const session = (accessToken='a'.repeat(32), refreshToken='r'.repeat(32)) => ({
  requestId:'request-session', userId:'user-1', sessionId:'session-1', accessToken,
  accessTokenExpiresAt:'2026-09-28T12:00:00Z', refreshToken, refreshTokenExpiresAt:'2026-10-28T12:00:00Z'
})

test('backend adapter reuses X-06 and keeps credentials out of persistent storage', async () => {
  const {api,calls,stored}=fixture(request => {
    if(request.url.endsWith('/session/wechat'))return {statusCode:201,data:session()}
    if(request.url.endsWith('/me'))return {statusCode:200,data:{requestId:'request-me',userId:'user-1',status:'active',profile:{campusId:'a'}}}
    throw new Error('Unexpected URL '+request.url)
  })
  const user=await api.loginWechat()
  assert.equal(user.profile.campusId,'a')
  assert.equal(calls[0].body.code,'test:miniapp-develop')
  assert.equal(calls[0].body.AppSecret,undefined)
  assert.equal(calls[0].headers['Idempotency-Key'],'login-fixed')
  assert.equal(api.isAuthenticated(),true)
  assert.equal(api.currentSession().accessToken,undefined)
  assert.equal(api.currentSession().refreshToken,undefined)
  assert.deepEqual([...stored.keys()],['tingyue.device.v1'])
})

test('401 refresh rotates the in-memory session once and retries through X-06', async () => {
  let workCalls=0
  const {api,calls}=fixture(request => {
    if(request.url.endsWith('/session/wechat'))return {statusCode:201,data:session('old-access','old-refresh')}
    if(request.url.endsWith('/me'))return {statusCode:200,data:{userId:'user-1',status:'active',profile:{}}}
    if(request.url.includes('/works')){
      workCalls++
      return workCalls===1 ? {statusCode:401,data:{error:{code:'ACCESS_TOKEN_EXPIRED'}}} : {statusCode:200,data:{items:[],nextCursor:null}}
    }
    if(request.url.endsWith('/session/refresh')){
      assert.equal(request.body.refreshToken,'old-refresh')
      return {statusCode:200,data:session('new-access','new-refresh')}
    }
    throw new Error('Unexpected URL '+request.url)
  })
  await api.loginWechat()
  assert.deepEqual((await api.listWorks()).items,[])
  assert.equal(workCalls,2)
  assert.equal(calls.at(-1).headers.Authorization,'Bearer new-access')
})

test('logout sends no JSON content type when the request body is empty', async () => {
  const {api,calls}=fixture(request => {
    if(request.url.endsWith('/session/wechat'))return {statusCode:201,data:session()}
    if(request.url.endsWith('/me'))return {statusCode:200,data:{userId:'user-1',status:'active',profile:{}}}
    if(request.url.endsWith('/session/current'))return {statusCode:200,data:{status:'revoked'}}
    throw new Error('Unexpected URL '+request.url)
  })
  await api.loginWechat()
  await api.logout()
  const logoutCall=calls.at(-1)
  assert.equal(logoutCall.method,'DELETE')
  assert.equal(logoutCall.body,undefined)
  assert.equal(logoutCall.headers['Content-Type'],undefined)
  assert.equal(logoutCall.headers['Idempotency-Key'],'logout-fixed')
  assert.equal(api.isAuthenticated(),false)
})

test('Quiz, local import, progress/word sync and ranking calls use the frozen backend contract fields', async () => {
  const {api,calls}=fixture(request => {
    if(request.url.endsWith('/session/wechat'))return {statusCode:201,data:session()}
    if(request.url.endsWith('/me'))return {statusCode:200,data:{userId:'user-1',status:'active',profile:{}}}
    return {statusCode:200,data:{requestId:'ok',status:'unavailable',items:[]}}
  })
  await api.loginWechat()
  const attempt={schemaVersion:1,attemptId:'attempt-1',workId:'peter-rabbit',pieceId:'peter-rabbit-01',contentVersion:1,quizVersion:1,questionIds:['q1'],selectedOptions:[0],startedAt:'2026-09-28T01:00:00Z',submittedAt:'2026-09-28T01:01:00Z',score:100,mastery:true}
  await api.submitQuiz(attempt)
  const importRequest={snapshotId:'s01-v1:'+'a'.repeat(64),payload:{schemaVersion:1,progress:[],words:[{surface:'Once'}],quizAttempts:[]},limitations:{words:'surface_only'}}
  await api.localImport(importRequest)
  const syncRequest={schemaVersion:1,batchId:'s02-batch-v1:'+'b'.repeat(64),cursor:null,operations:[],limit:100}
  await api.progressSync(syncRequest)
  const wordSyncRequest={schemaVersion:1,batchId:'s03-word-batch-v1:'+'c'.repeat(64),cursor:null,operations:[],limit:100}
  await api.savedWordSync(wordSyncRequest)
  await api.rankings({campusId:'b',periodType:'week',periodKey:'2026-W39',grade:'k',level:'5',limit:25})
  const quizCall=calls.find(call=>call.url.endsWith('/me/quiz-attempts'))
  assert.equal(quizCall.headers['Idempotency-Key'],'attempt-1')
  assert.equal(quizCall.body.score,undefined)
  assert.equal(quizCall.body.mastery,undefined)
  const importCall=calls.find(call=>call.url.endsWith('/me/local-import'))
  assert.equal(importCall.headers['Idempotency-Key'],importRequest.snapshotId)
  assert.deepEqual(importCall.body,importRequest)
  const syncCall=calls.find(call=>call.url.endsWith('/me/progress/sync'))
  assert.equal(syncCall.headers['Idempotency-Key'],syncRequest.batchId)
  assert.deepEqual(syncCall.body,syncRequest)
  const wordSyncCall=calls.find(call=>call.url.endsWith('/me/words/sync'))
  assert.equal(wordSyncCall.headers['Idempotency-Key'],wordSyncRequest.batchId)
  assert.deepEqual(wordSyncCall.body,wordSyncRequest)
  const rankingCall=calls.at(-1)
  assert.match(rankingCall.url,/campusId=b/)
  assert.match(rankingCall.url,/periodType=week/)
  assert.match(rankingCall.url,/periodKey=2026-W39/)
})
