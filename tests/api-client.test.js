const assert=require('node:assert/strict')
const test=require('node:test')

const storage=new Map()
const calls=[]
let responder=()=>({statusCode:500,data:{error:{code:'INTERNAL_ERROR',message:'unexpected',retryable:false,details:null}}})

global.wx={
  isBrowserPreview:false,
  getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),
  getExtConfigSync:()=>({}),
  getStorageSync:key=>storage.get(key),
  setStorageSync:(key,value)=>storage.set(key,value),
  removeStorageSync:key=>storage.delete(key),
  login:({success})=>success({code:'real-wx-code'}),
  request:options=>{calls.push(options);const response=responder(options);if(response instanceof Error)options.fail({errMsg:response.message});else options.success(Object.assign({header:{}},response))}
}

const api=require('../miniprogram/services/api')

test.beforeEach(()=>{storage.clear();calls.length=0})

test('development login uses the explicit stub identity and stores contract session data',async()=>{
  responder=options=>{
    if(options.url.endsWith('/api/v1/session/wechat'))return {statusCode:201,data:{requestId:'request-login',userId:'user-1',sessionId:'session-1',accessToken:'a'.repeat(32),accessTokenExpiresAt:'2026-09-24T05:00:00Z',refreshToken:'r'.repeat(32),refreshTokenExpiresAt:'2026-10-24T05:00:00Z'}}
    if(options.url.endsWith('/api/v1/me'))return {statusCode:200,data:{requestId:'request-me',userId:'user-1',status:'active',profile:{campusId:'a',grade:'3',readingLevel:'3'}}}
    throw new Error('unexpected URL '+options.url)
  }
  const user=await api.loginWechat()
  assert.equal(user.profile.campusId,'a')
  assert.equal(calls[0].data.code,'test:miniapp-develop')
  assert.equal(calls[0].data.AppSecret,undefined)
  assert.equal(api.isAuthenticated(),true)
  assert.equal(api.currentUser().userId,'user-1')
})

test('authenticated requests refresh once on token expiry then retry with the rotated token',async()=>{
  api.storeSession({accessToken:'old-access',refreshToken:'old-refresh',user:{userId:'user-1'}})
  let workCalls=0
  responder=options=>{
    if(options.url.includes('/api/v1/works')){
      workCalls++
      if(workCalls===1)return {statusCode:401,data:{requestId:'expired',error:{code:'ACCESS_TOKEN_EXPIRED',message:'expired',retryable:false,details:null}}}
      assert.equal(options.header.authorization,'Bearer new-access')
      return {statusCode:200,data:{requestId:'works',items:[],nextCursor:null}}
    }
    if(options.url.endsWith('/api/v1/session/refresh'))return {statusCode:200,data:{requestId:'refresh',userId:'user-1',sessionId:'session-2',accessToken:'new-access',accessTokenExpiresAt:'2026-09-24T06:00:00Z',refreshToken:'new-refresh',refreshTokenExpiresAt:'2026-10-24T06:00:00Z'}}
    throw new Error('unexpected URL '+options.url)
  }
  const result=await api.listWorks()
  assert.deepEqual(result.items,[])
  assert.equal(workCalls,2)
  assert.equal(api.session().refreshToken,'new-refresh')
  assert.equal(api.currentUser().userId,'user-1')
})

test('ranking requests map UI filters to the frozen backend parameter names',async()=>{
  api.storeSession({accessToken:'access',refreshToken:'refresh'})
  responder=options=>({statusCode:200,data:{requestId:'ranking',status:'unavailable',items:[]}})
  await api.rankings({campusId:'b',periodType:'week',periodKey:'2026-W39',grade:'k',level:'5',limit:25})
  assert.match(calls[0].url,/campusId=b/)
  assert.match(calls[0].url,/periodType=week/)
  assert.match(calls[0].url,/periodKey=2026-W39/)
  assert.match(calls[0].url,/grade=k/)
  assert.match(calls[0].url,/level=5/)
  assert.equal(calls[0].header.authorization,'Bearer access')
})
