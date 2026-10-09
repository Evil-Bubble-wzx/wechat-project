const api = require('../../services/api')
const host = require('../../services/host')

const SCHEMA_VERSION = 1
const EXPECTED_CONTRACT = 'api-contract-v1.2.0'
const MAX_BACKOFF_MS = 5 * 60 * 1000
const ACTIVE_SYNC_INTERVAL_MS = 30 * 1000
let flushInFlight = null
let pullInFlight = null
let wakeTimer = null

const keyFor = (pieceId, contentVersion) => pieceId + '@' + contentVersion
const cloneRanges = ranges => (Array.isArray(ranges) ? ranges : []).map(range => [Math.round(Number(range[0]) * 1000), Math.round(Number(range[1]) * 1000)])
const mutationId = () => 'progress-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14)
function runnable() {
  const user=api.currentUser()
  return !!(user&&user.userId&&host.accountScope()===user.userId&&api.available()&&api.isAuthenticated()&&api.progressSyncAvailable()&&!host.policy().isDemo)
}
function payloadFor(baseRevision, entry) {
  return {schemaVersion:SCHEMA_VERSION,mutationId:mutationId(),baseRevision:String(baseRevision||'0'),contentVersion:Number(entry.contentVersion),checkpointMs:Math.round((Number(entry.checkpointSeconds)||0)*1000),listenedRangesMs:cloneRanges(entry.listenedRanges)}
}
function sameEvidence(a,b) {
  if(!a||!b)return false
  const left=Object.assign({},a,{mutationId:undefined}),right=Object.assign({},b,{mutationId:undefined})
  return JSON.stringify(left)===JSON.stringify(right)
}
function capture(state,pieceId,entry,options={}) {
  if(!runnable()||!pieceId||!Number.isInteger(Number(entry&&entry.contentVersion)))return state
  state.progressSyncOutbox=Object.assign({},state.progressSyncOutbox||{})
  state.progressSyncBaselines=Object.assign({},state.progressSyncBaselines||{})
  const key=keyFor(pieceId,Number(entry.contentVersion)),base=state.progressSyncBaselines[key],request=payloadFor(base&&base.revision,entry),existing=state.progressSyncOutbox[key]
  if(existing&&sameEvidence(existing.request,request))return state
  state.progressSyncOutbox[key]={pieceId,key,request,attempts:0,nextAttemptAt:options.immediate?0:(existing?Number(existing.nextAttemptAt)||0:Date.now()+ACTIVE_SYNC_INTERVAL_MS),status:'pending',lastError:null}
  return state
}
function applyRemote(state,remote) {
  const key=keyFor(remote.pieceId,remote.contentVersion),pending=(state.progressSyncOutbox||{})[key]
  state.progressSyncBaselines=Object.assign({},state.progressSyncBaselines||{}, {[key]:remote})
  if(remote.historicalVersion)return state
  state.progress=Object.assign({},state.progress||{})
  const local=state.progress[remote.pieceId]||{},ranges=(pending&&local.contentVersion===remote.contentVersion)?mergeSeconds(remote.listenedRangesMs,local.listenedRanges):remote.listenedRangesMs.map(range=>range.map(value=>value/1000))
  const checkpoint=pending&&local.contentVersion===remote.contentVersion?Number(local.checkpointSeconds)||0:remote.checkpointMs/1000
  state.progress[remote.pieceId]=Object.assign({},local,{seconds:checkpoint,checkpointSeconds:checkpoint,contentVersion:remote.contentVersion,listenedRanges:ranges,listenedSeconds:remote.listenedMs/1000,coverage:remote.coverage,completed:remote.completed,completionReason:remote.completed?'coverage_and_ended':null,schemaVersion:2,serverRevision:remote.revision,serverUpdatedAt:remote.serverUpdatedAt})
  return state
}
function mergeSeconds(remoteMs,localSeconds) {
  const ranges=[...remoteMs.map(range=>range.map(value=>value/1000)),...(Array.isArray(localSeconds)?localSeconds:[])].sort((a,b)=>a[0]-b[0]),out=[]
  for(const range of ranges){const last=out[out.length-1];if(last&&range[0]<=last[1]+.05)last[1]=Math.max(last[1],range[1]);else out.push(range.slice())}
  return out
}
async function flush() {
  if(flushInFlight)return flushInFlight
  if(!runnable())return null
  const userId=api.currentUser().userId
  flushInFlight=(async()=>{
    while(runnable()&&api.currentUser().userId===userId){
      const state=host.read(),items=Object.values(state.progressSyncOutbox||{}).filter(item=>Number(item.nextAttemptAt||0)<=Date.now())
      const item=items[0];if(!item)break
      try{
        const response=await api.putProgress(item.pieceId,item.request)
        if(!runnable()||api.currentUser().userId!==userId)break
        host.mutate(latest=>{
          latest.progressSyncOutbox=Object.assign({},latest.progressSyncOutbox||{})
          const current=latest.progressSyncOutbox[item.key]
          if(current&&current.request.mutationId===item.request.mutationId)delete latest.progressSyncOutbox[item.key]
          else if(current){current.request=Object.assign({},current.request,{mutationId:mutationId(),baseRevision:response.progress.revision});current.attempts=0;current.nextAttemptAt=0}
          applyRemote(latest,response.progress)
          return latest
        })
      }catch(error){
        if(!runnable()||api.currentUser().userId!==userId)break
        host.mutate(latest=>{
          latest.progressSyncOutbox=Object.assign({},latest.progressSyncOutbox||{})
          const current=latest.progressSyncOutbox[item.key];if(!current||current.request.mutationId!==item.request.mutationId)return latest
          if(error&&error.retryable){current.attempts=(Number(current.attempts)||0)+1;current.nextAttemptAt=Date.now()+Math.min(MAX_BACKOFF_MS,1000*Math.pow(2,Math.min(current.attempts,8)));current.lastError={kind:error.kind||'network',serverCode:error.serverCode||null,requestId:error.requestId||null};schedule(current.nextAttemptAt-Date.now())}
          else{latest.progressSyncFailures=Object.assign({},latest.progressSyncFailures||{}, {[item.key]:{pieceId:item.pieceId,contentVersion:item.request.contentVersion,reason:error&&error.serverCode||error&&error.kind||'unknown',requestId:error&&error.requestId||null,failedAt:new Date().toISOString()}});delete latest.progressSyncOutbox[item.key]}
          return latest
        })
        break
      }
    }
  })().finally(()=>{flushInFlight=null;scheduleNext()})
  return flushInFlight
}
async function pullAll() {
  if(pullInFlight)return pullInFlight
  if(!runnable())return null
  const userId=api.currentUser().userId
  pullInFlight=(async()=>{let cursor=null;do{const page=await api.listProgress(cursor,100);if(!runnable()||api.currentUser().userId!==userId)return;host.mutate(state=>{for(const remote of page.items||[])applyRemote(state,remote);return state});cursor=page.nextCursor}while(cursor);host.mutate(state=>{state.progressSyncFailures=Object.assign({},state.progressSyncFailures||{});delete state.progressSyncFailures.__pull__;return state})})().finally(()=>{pullInFlight=null})
  return pullInFlight
}
async function pullPiece(pieceId) {
  if(!runnable())return null
  const userId=api.currentUser().userId,response=await api.getProgress(pieceId)
  if(runnable()&&api.currentUser().userId===userId)host.mutate(state=>applyRemote(state,response.progress))
  return response.progress
}
function schedule(delay=0){if(wakeTimer)clearTimeout(wakeTimer);wakeTimer=setTimeout(()=>{wakeTimer=null;void flush()},Math.max(0,Math.min(MAX_BACKOFF_MS,delay)))}
function scheduleNext(){if(!runnable())return;const items=Object.values(host.read().progressSyncOutbox||{});if(!items.length)return;const next=Math.min(...items.map(item=>Number(item.nextAttemptAt)||0));schedule(Math.max(0,next-Date.now()))}
function kick(){scheduleNext()}
function recordPullFailure(error){if(!runnable())return;host.mutate(state=>{state.progressSyncFailures=Object.assign({},state.progressSyncFailures||{}, {__pull__:{reason:error&&error.serverCode||error&&error.kind||'network',requestId:error&&error.requestId||null,failedAt:new Date().toISOString()}});return state})}
async function activate(){if(!runnable())return;try{await pullAll()}catch(error){recordPullFailure(error)}await flush();scheduleNext()}
function deactivate(){if(wakeTimer)clearTimeout(wakeTimer);wakeTimer=null}
async function retry(){if(!runnable())return null;host.mutate(state=>{for(const item of Object.values(state.progressSyncOutbox||{})){item.nextAttemptAt=0;item.status='pending'}return state});try{await pullAll()}catch(error){recordPullFailure(error)}return flush()}
function view(state=host.read()) {
  const pending=Object.keys(state.progressSyncOutbox||{}).length,failed=Object.keys(state.progressSyncFailures||{}).length
  return {status:failed?'failed':pending?'pending':'synced',pending,failed,label:failed?'部分进度未同步':pending?'进度等待同步':'学习进度已同步'}
}
function resetForTests(){flushInFlight=null;pullInFlight=null;if(wakeTimer)clearTimeout(wakeTimer);wakeTimer=null}

module.exports={capture,flush,pullAll,pullPiece,activate,deactivate,retry,view,kick,_applyRemote:applyRemote,_mergeSeconds:mergeSeconds,_resetForTests:resetForTests,_constants:{EXPECTED_CONTRACT,MAX_BACKOFF_MS,ACTIVE_SYNC_INTERVAL_MS}}
