const apiConfig = require('../config/api')

const SESSION_KEY = 'tingyue.session.v1'
const DEVICE_KEY = 'tingyue.device.v1'
let refreshPromise = null

class ApiClientError extends Error {
  constructor(code,message,statusCode=0,retryable=false,requestId=null,details=null) {
    super(message);this.name='ApiClientError';this.code=code;this.statusCode=statusCode;this.retryable=retryable;this.requestId=requestId;this.details=details
  }
}

const randomId = prefix => prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12)
function session() { try { return wx.getStorageSync(SESSION_KEY)||null } catch (_) { return null } }
function storeSession(value) { if(value)wx.setStorageSync(SESSION_KEY,value);else wx.removeStorageSync(SESSION_KEY) }
function isAuthenticated() { const value=session();return !!(value&&value.accessToken&&value.refreshToken) }
function currentUser() { return session()?.user||null }
function available() { const config=apiConfig.current();return !wx.isBrowserPreview&&typeof wx.request==='function'&&!!config.baseUrl }
function deviceId() { let value='';try{value=wx.getStorageSync(DEVICE_KEY)||''}catch(_){}if(!value){value=randomId('device');try{wx.setStorageSync(DEVICE_KEY,value)}catch(_){}}return value }

function rawRequest(options) {
  return new Promise((resolve,reject)=>{
    wx.request(Object.assign({},options,{
      timeout:10000,
      success:resolve,
      fail:error=>reject(new ApiClientError('DEPENDENCY_UNAVAILABLE',error?.errMsg||'Backend request failed',0,true))
    }))
  })
}

function apiError(response) {
  const body=response?.data||{},error=body.error||{}
  return new ApiClientError(error.code||'INTERNAL_ERROR',error.message||'Backend request failed',response?.statusCode||0,!!error.retryable,body.requestId||response?.header?.['x-request-id']||null,error.details??null)
}

async function refresh() {
  if(refreshPromise)return refreshPromise
  const saved=session()
  if(!saved?.refreshToken)throw new ApiClientError('UNAUTHENTICATED','Login is required',401,false)
  refreshPromise=(async()=>{
    const config=apiConfig.current()
    const response=await rawRequest({url:config.baseUrl+'/api/v1/session/refresh',method:'POST',header:{'content-type':'application/json','idempotency-key':randomId('refresh')},data:{refreshToken:saved.refreshToken}})
    if(response.statusCode<200||response.statusCode>=300){storeSession(null);throw apiError(response)}
    const next=Object.assign({},response.data,{user:saved.user||null})
    storeSession(next)
    return next
  })().finally(()=>{refreshPromise=null})
  return refreshPromise
}

async function request(path,{method='GET',data,query,authorized=true,idempotencyKey,retry=true}={}) {
  if(!available())throw new ApiClientError('DEPENDENCY_UNAVAILABLE','Backend is not configured',0,true)
  const config=apiConfig.current(),saved=session()
  if(authorized&&!saved?.accessToken)throw new ApiClientError('UNAUTHENTICATED','Login is required',401,false)
  const queryString=Object.entries(query||{}).filter(([,value])=>value!==undefined&&value!==null&&value!=='').map(([key,value])=>encodeURIComponent(key)+'='+encodeURIComponent(String(value))).join('&')
  const header={}
  if(data!==undefined)header['content-type']='application/json'
  if(authorized)header.authorization='Bearer '+saved.accessToken
  if(method!=='GET')header['idempotency-key']=idempotencyKey||randomId('mutation')
  const response=await rawRequest({url:config.baseUrl+path+(queryString?'?'+queryString:''),method,header,data})
  if(response.statusCode>=200&&response.statusCode<300)return response.data
  const error=apiError(response)
  if(authorized&&retry&&(error.code==='ACCESS_TOKEN_EXPIRED'||error.code==='UNAUTHENTICATED')&&saved?.refreshToken){await refresh();return request(path,{method,data,query,authorized,idempotencyKey,retry:false})}
  throw error
}

function loginCode() { return new Promise((resolve,reject)=>wx.login({success:result=>result?.code?resolve(result.code):reject(new ApiClientError('AUTH_CODE_INVALID','wx.login returned no code')),fail:error=>reject(new ApiClientError('AUTH_CODE_INVALID',error?.errMsg||'wx.login failed'))})) }
async function loginWechat() {
  if(!available())throw new ApiClientError('DEPENDENCY_UNAVAILABLE','Backend is not configured',0,true)
  const config=apiConfig.current(),wechatCode=await loginCode(),code=config.development&&config.stubLoginCode?config.stubLoginCode:wechatCode
  const response=await request('/api/v1/session/wechat',{method:'POST',authorized:false,idempotencyKey:randomId('login'),data:{code,deviceId:deviceId()}})
  storeSession(response)
  const user=await getMe()
  return user
}
async function getMe() { const user=await request('/api/v1/me');const saved=session();storeSession(Object.assign({},saved,{user}));return user }
async function logout() { const saved=session();if(!saved?.accessToken){storeSession(null);return}try{await request('/api/v1/session/current',{method:'DELETE',idempotencyKey:randomId('logout'),retry:false})}finally{storeSession(null)} }

const rankingQuery=filters=>({campusId:filters.campusId,periodType:filters.periodType,periodKey:filters.periodKey,grade:filters.grade,level:filters.level,cursor:filters.cursor,limit:filters.limit||50})
module.exports={
  ApiClientError,SESSION_KEY,available,isAuthenticated,currentUser,session,storeSession,loginWechat,getMe,logout,refresh,request,
  listWorks:(cursor,limit=50)=>request('/api/v1/works',{query:{cursor,limit}}),
  getWork:workId=>request('/api/v1/works/'+encodeURIComponent(workId)),
  getManifest:(pieceId,contentVersion)=>request('/api/v1/pieces/'+encodeURIComponent(pieceId)+'/manifest',{query:{contentVersion}}),
  submitQuiz:attempt=>request('/api/v1/me/quiz-attempts',{method:'POST',idempotencyKey:attempt.attemptId,data:{schemaVersion:attempt.schemaVersion,attemptId:attempt.attemptId,workId:attempt.workId,pieceId:attempt.pieceId,contentVersion:attempt.contentVersion,quizVersion:attempt.quizVersion,questionIds:attempt.questionIds,selectedOptions:attempt.selectedOptions,startedAt:attempt.startedAt,submittedAt:attempt.submittedAt}}),
  rankingOptions:()=>request('/api/v1/ranking-options'),
  rankings:filters=>request('/api/v1/rankings',{query:rankingQuery(filters)}),
  rankingDetail:(participantId,filters)=>request('/api/v1/rankings/'+encodeURIComponent(participantId)+'/quizzes',{query:rankingQuery(filters)})
}
