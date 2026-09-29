const { canonicalStringify, sha256 } = require('./local-import')

const SCHEMA_VERSION = 1
const STORAGE_PREFIX = 'tingyue.progressSync.v1:'
const RETRY_DELAYS_MS = [1000, 5000, 30000, 120000, 600000]
const MAX_RETRY_MS = 1800000
const MAX_TERMINAL = 20
const PERIODIC_FLUSH_MS = 15000

const clone = value => JSON.parse(JSON.stringify(value))
const clamp = (value, min, max) => Math.max(min, Math.min(Number(value) || 0, max))
const keyFor = userId => STORAGE_PREFIX + encodeURIComponent(userId)
const fingerprint = value => canonicalStringify(value)

function normalizeRanges(input, durationMs) {
  const ranges = (Array.isArray(input) ? input : [])
    .map(range => [Math.round(clamp(range && range[0], 0, durationMs)), Math.round(clamp(range && range[1], 0, durationMs))])
    .filter(range => range[1] > range[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range[0] <= previous[1] + 50) previous[1] = Math.max(previous[1], range[1])
    else merged.push(range)
  }
  return merged
}

function subtractRanges(input, excluded, durationMs) {
  const source = normalizeRanges(input, durationMs)
  const mask = normalizeRanges(excluded, durationMs)
  const output = []
  for (const [sourceStart, sourceEnd] of source) {
    let parts = [[sourceStart, sourceEnd]]
    for (const [maskStart, maskEnd] of mask) {
      const next = []
      for (const [start, end] of parts) {
        if (maskEnd <= start || maskStart >= end) next.push([start, end])
        else {
          if (maskStart > start) next.push([start, Math.min(end, maskStart)])
          if (maskEnd < end) next.push([Math.max(start, maskEnd), end])
        }
      }
      parts = next
      if (!parts.length) break
    }
    output.push(...parts)
  }
  return normalizeRanges(output, durationMs)
}

function operationIdFor(operation) {
  return 's02-op-v1:' + sha256(canonicalStringify(operation))
}

function batchIdFor(batch) {
  return 's02-batch-v1:' + sha256(canonicalStringify(batch))
}

function emptyAccount(userId) {
  return { schemaVersion:SCHEMA_VERSION, userId, cursor:null, pieces:{}, blocked:{}, drafts:{}, queue:[], terminal:[], retryAttempt:0, lastSyncedAt:null }
}

function normalizeAccount(value, userId) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.userId !== userId) return emptyAccount(userId)
  return Object.assign(emptyAccount(userId), clone(value), {
    pieces:Object.assign({},value.pieces||{}), blocked:Object.assign({},value.blocked||{}), drafts:Object.assign({},value.drafts||{}),
    queue:Array.isArray(value.queue)?value.queue:[], terminal:Array.isArray(value.terminal)?value.terminal.slice(0,MAX_TERMINAL):[]
  })
}

function localProgress(entry, pieceId) {
  const durationMs = Math.round((Number(entry && entry.duration) || 0) * 1000)
  if (!pieceId || !Number.isInteger(entry && entry.contentVersion) || durationMs <= 0) return null
  return {
    pieceId,
    contentVersion:entry.contentVersion,
    durationMs,
    checkpointMs:Math.round(clamp(entry.checkpointSeconds,0,durationMs/1000)*1000),
    listenedRangesMs:normalizeRanges((entry.listenedRanges||[]).map(range=>[Number(range[0])*1000,Number(range[1])*1000]),durationMs),
    naturalEndObserved:!!entry.naturalEndObserved,
    occurredAt:typeof entry.updatedAt==='string'&&Number.isFinite(Date.parse(entry.updatedAt))?new Date(entry.updatedAt).toISOString():new Date().toISOString()
  }
}

function createProgressSyncManager(options = {}) {
  const runtime = options.runtime || (typeof wx === 'undefined' ? null : wx)
  const api = options.api || require('../../services/api')
  const host = options.host || require('../../services/host')
  const player = options.player || require('../listen-read/player')
  const now = options.now || (() => Date.now())
  const random = options.random || Math.random
  const schedule = options.schedule || ((fn, delay) => setTimeout(fn, delay))
  const cancel = options.cancel || (timer => clearTimeout(timer))
  const readLocalProgress = options.readLocalProgress || (() => (host.read().progress || {}))
  const submit = options.submit || (request => api.progressSync(request))
  const applyRemote = options.applyRemote || (progress => applyRemoteToHost(host, progress))
  const isAuthenticated = options.isAuthenticated || (() => api.isAuthenticated())
  const currentUser = options.currentUser || (() => api.currentUser())
  let activeUserId = null
  let account = null
  let sessionBaseline = {}
  let busy = false
  let pendingPull = false
  let started = false
  let timer = null
  let playerUnsubscribe = null
  const subscribers = new Set()
  let currentStatus = { status:'idle', pendingCount:0, lastSyncedAt:null, error:null }

  function readStored(userId) {
    try { return normalizeAccount(runtime && runtime.getStorageSync(keyFor(userId)),userId) }
    catch (_) { return emptyAccount(userId) }
  }
  function save() {
    if (!account || !activeUserId) return
    try { runtime && runtime.setStorageSync(keyFor(activeUserId),clone(account)) } catch (_) {}
    updateStatus(currentStatus.status,currentStatus.error)
  }
  function pendingCount() {
    if (!account) return 0
    return Object.keys(account.drafts).length + account.queue.reduce((total,batch)=>total+batch.operations.length,0)
  }
  function updateStatus(status, error = null) {
    currentStatus={status,pendingCount:pendingCount(),lastSyncedAt:account&&account.lastSyncedAt||null,error}
    for(const subscriber of [...subscribers])subscriber(Object.assign({},currentStatus))
  }
  function subscribe(subscriber) {
    subscribers.add(subscriber);subscriber(Object.assign({},currentStatus));return()=>subscribers.delete(subscriber)
  }
  function baselineFor(pieceId, contentVersion) {
    const baseline=sessionBaseline[pieceId]
    return baseline&&baseline.contentVersion===contentVersion?baseline:null
  }
  function knownFor(pieceId, contentVersion) {
    const known=account&&account.pieces[pieceId]
    return known&&known.contentVersion===contentVersion?known:null
  }
  function snapshotBaseline() {
    const output={}
    for(const [pieceId,entry] of Object.entries(readLocalProgress()||{})){
      const normalized=localProgress(entry,pieceId);if(normalized)output[pieceId]=normalized
    }
    return output
  }

  function activate(userId, settings = {}) {
    if (typeof userId !== 'string' || !userId) return false
    if (timer) { cancel(timer);timer=null }
    activeUserId=userId;account=readStored(userId);sessionBaseline=snapshotBaseline();pendingPull=false
    updateStatus(account.queue.length||Object.keys(account.drafts).length?'pending':'idle')
    if (settings.sync !== false) void trigger('login',true)
    return true
  }
  function deactivate() {
    if(timer){cancel(timer);timer=null}activeUserId=null;account=null;sessionBaseline={};pendingPull=false;busy=false;updateStatus('idle')
  }

  function record(entry, pieceId, immediate = false) {
    if (!activeUserId || !account || !isAuthenticated()) return false
    const local=localProgress(entry,pieceId)
    if(!local)return false
    const blocked=account.blocked[pieceId]
    if(blocked&&blocked.contentVersion===local.contentVersion)return false
    const baseline=baselineFor(pieceId,local.contentVersion)
    const known=knownFor(pieceId,local.contentVersion)
    const excluded=[...(baseline?.listenedRangesMs||[]),...(known?.listenedRangesMs||[])]
    const listenedRangeDeltasMs=subtractRanges(local.listenedRangesMs,excluded,local.durationMs)
    const checkpointMoved=local.checkpointMs!==(baseline?.checkpointMs??local.checkpointMs)&&local.checkpointMs!==(known?.checkpointMs??-1)
    const checkpointBackedByNewEvidence=listenedRangeDeltasMs.some(range=>range[0]<=local.checkpointMs&&range[1]>=local.checkpointMs-250)
    const checkpointChanged=checkpointMoved&&(!known||local.checkpointMs>known.checkpointMs||checkpointBackedByNewEvidence)
    const naturalEndObserved=local.naturalEndObserved&&!baseline?.naturalEndObserved&&!known?.naturalEndObserved
    if(!listenedRangeDeltasMs.length&&!checkpointChanged&&!naturalEndObserved)return false
    account.drafts[pieceId]={
      pieceId:local.pieceId,contentVersion:local.contentVersion,durationMs:local.durationMs,
      listenedRangeDeltasMs,checkpointMs:checkpointChanged?local.checkpointMs:null,
      naturalEndObserved,occurredAt:local.occurredAt
    }
    save();updateStatus(busy?'syncing':'pending')
    if(immediate)void trigger('playback',true)
    else schedulePeriodic()
    return true
  }

  function schedulePeriodic() {
    if(timer||busy)return
    timer=schedule(()=>{timer=null;void trigger('periodic',false)},PERIODIC_FLUSH_MS)
  }
  function retryDelay(attempt) {
    const base=attempt<RETRY_DELAYS_MS.length?RETRY_DELAYS_MS[attempt]:Math.min(MAX_RETRY_MS,RETRY_DELAYS_MS[RETRY_DELAYS_MS.length-1]*Math.pow(2,attempt-RETRY_DELAYS_MS.length+1))
    return Math.min(MAX_RETRY_MS,Math.round(base+base*.2*clamp(random(),0,1)))
  }
  function scheduleRetry(error) {
    if(timer)return
    const attempt=account.retryAttempt||0,delay=retryDelay(attempt);account.retryAttempt=attempt+1;save();updateStatus('error',error&&error.serverCode||error&&error.kind||'network')
    timer=schedule(()=>{timer=null;void trigger('retry',true)},delay)
  }

  function materialize(pull) {
    if(!account||account.queue.length)return null
    const keys=Object.keys(account.drafts).sort().slice(0,50)
    if(!keys.length&&!pull)return null
    const operations=keys.map(pieceId=>{
      const draft=account.drafts[pieceId],known=knownFor(pieceId,draft.contentVersion)
      const payload={pieceId:draft.pieceId,contentVersion:draft.contentVersion,durationMs:draft.durationMs,baseRevision:known?.revision||'0',listenedRangeDeltasMs:draft.listenedRangeDeltasMs,checkpointMs:draft.checkpointMs,naturalEndObserved:draft.naturalEndObserved,occurredAt:draft.occurredAt}
      return Object.assign({operationId:operationIdFor(payload)},payload)
    })
    const payload={schemaVersion:SCHEMA_VERSION,cursor:account.cursor,operations,limit:100}
    const batch=Object.assign({batchId:batchIdFor(payload)},payload)
    for(const key of keys)delete account.drafts[key]
    account.queue.push(batch);save();return batch
  }

  function rememberTerminal(item) {
    account.terminal=[Object.assign({recordedAt:new Date(now()).toISOString()},item),...account.terminal].slice(0,MAX_TERMINAL)
  }
  function acceptProgress(progress) {
    if(!progress||!progress.pieceId)return
    account.pieces[progress.pieceId]=clone(progress)
    delete account.blocked[progress.pieceId]
    applyRemote(progress)
  }
  function handleResponse(batch,response) {
    if(!response||response.batchId!==batch.batchId)throw Object.assign(new Error('Progress sync response batch mismatch'),{retryable:false,kind:'contract'})
    account.queue.shift();account.retryAttempt=0
    const submitted=new Map(batch.operations.map(operation=>[operation.operationId,operation]))
    for(const result of response.operations||[]){
      if(result.progress)acceptProgress(result.progress)
      if(result.status==='rejected'){
        const operation=submitted.get(result.operationId)
        if(operation)account.blocked[result.pieceId]={contentVersion:operation.contentVersion,reason:result.reason,recordedAt:new Date(now()).toISOString()}
        rememberTerminal({operationId:result.operationId,pieceId:result.pieceId,reason:result.reason})
      }
    }
    for(const progress of response.changes||[])acceptProgress(progress)
    account.cursor=response.nextCursor||account.cursor
    account.lastSyncedAt=response.serverTime||new Date(now()).toISOString()
    save()
    return !!response.hasMore
  }

  async function trigger(_reason, pull = true) {
    if(!activeUserId||!account||!isAuthenticated()||currentUser()?.userId!==activeUserId)return false
    pendingPull=pendingPull||pull
    if(busy)return false
    if(timer){cancel(timer);timer=null}
    busy=true;updateStatus('syncing')
    try{
      let wantsPull=pendingPull;pendingPull=false
      while(activeUserId&&account&&isAuthenticated()){
        let batch=account.queue[0]||materialize(wantsPull)
        wantsPull=false
        if(!batch)break
        try{
          const response=await submit(clone(batch))
          const hasMore=handleResponse(batch,response)
          if(hasMore)wantsPull=true
          if(!account.queue.length&&Object.keys(account.drafts).length)materialize(false)
          else if(!account.queue.length&&wantsPull)materialize(true)
        }catch(error){
          if(error&&error.kind==='unauthorized'){updateStatus('error','authentication');return false}
          if(error&&error.retryable===false){
            account.queue.shift()
            const reason=error.serverCode||error.kind||'terminal_error'
            for(const operation of batch.operations)account.blocked[operation.pieceId]={contentVersion:operation.contentVersion,reason,recordedAt:new Date(now()).toISOString()}
            rememberTerminal({batchId:batch.batchId,reason});save();continue
          }
          scheduleRetry(error);return false
        }
      }
      updateStatus('synced');return true
    }finally{busy=false;if(pendingPull)void trigger('pending',true)}
  }

  function foreground() {
    const user=currentUser()
    if(user&&user.userId&&isAuthenticated()&&activeUserId!==user.userId)activate(user.userId,{sync:false})
    if(activeUserId)void trigger('foreground',true)
  }
  function start() {
    if(started)return;started=true
    if(player&&typeof player.subscribeProgress==='function')playerUnsubscribe=player.subscribeProgress(event=>record(event.entry,event.pieceId,event.immediate))
    if(runtime&&typeof runtime.onNetworkStatusChange==='function')runtime.onNetworkStatusChange(result=>{if(result&&result.isConnected&&activeUserId)void trigger('network-restored',true)})
  }
  function stop() {if(playerUnsubscribe)playerUnsubscribe();playerUnsubscribe=null;started=false;deactivate()}
  function inspect() {return account?clone(account):null}

  return {start,stop,activate,deactivate,foreground,trigger,record,subscribe,status:()=>Object.assign({},currentStatus),_inspect:inspect,_retryDelay:retryDelay}
}

function applyRemoteToHost(host, progress) {
  host.mutate(current=>{
    current.progress=Object.assign({},current.progress||{})
    const previous=current.progress[progress.pieceId]||{}
    const sameVersion=previous.contentVersion===progress.contentVersion
    current.progress[progress.pieceId]=Object.assign({},sameVersion?previous:{},{
      seconds:progress.checkpointMs/1000,
      checkpointSeconds:progress.checkpointMs/1000,
      completed:!!progress.completed,
      duration:progress.durationMs/1000,
      listenedRanges:(progress.listenedRangesMs||[]).map(range=>range.map(value=>value/1000)),
      listenedSeconds:progress.listenedMs/1000,
      coverage:progress.coverage,
      completionReason:progress.completed?'coverage_and_ended':null,
      naturalEndObserved:!!progress.naturalEndObserved,
      contentVersion:progress.contentVersion,
      schemaVersion:2,
      syncRevision:progress.revision,
      syncServerUpdatedAt:progress.serverUpdatedAt,
      updatedAt:progress.serverUpdatedAt
    })
    current.progressSchemaVersion=2
    return current
  })
}

const singleton=createProgressSyncManager()
module.exports={
  SCHEMA_VERSION,STORAGE_PREFIX,createProgressSyncManager,normalizeRanges,subtractRanges,operationIdFor,batchIdFor,
  start:()=>singleton.start(),stop:()=>singleton.stop(),activate:(userId,settings)=>singleton.activate(userId,settings),deactivate:()=>singleton.deactivate(),foreground:()=>singleton.foreground(),trigger:(reason,pull)=>singleton.trigger(reason,pull),record:(entry,pieceId,immediate)=>singleton.record(entry,pieceId,immediate),subscribe:subscriber=>singleton.subscribe(subscriber),status:()=>singleton.status()
}
