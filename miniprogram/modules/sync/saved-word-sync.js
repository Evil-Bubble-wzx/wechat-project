const { canonicalStringify, sha256 } = require('./local-import')

const SCHEMA_VERSION = 1
const STORAGE_PREFIX = 'tingyue.wordSync.v1:'
const RETRY_DELAYS_MS = [1000, 5000, 30000, 120000, 600000]
const MAX_RETRY_MS = 1800000
const MAX_TERMINAL = 20

const clone = value => JSON.parse(JSON.stringify(value))
const keyFor = userId => STORAGE_PREFIX + encodeURIComponent(userId)

function operationIdFor(operation) {
  return 's03-word-op-v1:' + sha256(canonicalStringify(operation))
}

function batchIdFor(batch) {
  return 's03-word-batch-v1:' + sha256(canonicalStringify(batch))
}

function normalizeEntry(value) {
  if (!value || !/^ve-[a-f0-9]{12,64}$/.test(String(value.entryId || ''))) return null
  const entry = {
    entryId:String(value.entryId),pieceId:String(value.pieceId||''),contentVersion:Number(value.contentVersion),
    vocabKey:String(value.vocabKey||''),surface:String(value.surface||'').trim(),lemma:String(value.lemma||'').trim()
  }
  if(!entry.pieceId||!Number.isInteger(entry.contentVersion)||entry.contentVersion<1||!entry.vocabKey||!entry.surface||!entry.lemma)return null
  if(entry.pieceId.length>128||entry.vocabKey.length>128||entry.surface.length>80||entry.lemma.length>80)return null
  return entry
}

function emptyAccount(userId) {
  return {schemaVersion:SCHEMA_VERSION,userId,cursor:null,words:{},blocked:{},drafts:{},queue:[],terminal:[],retryAttempt:0,lastSyncedAt:null}
}

function normalizeAccount(value,userId) {
  if(!value||value.schemaVersion!==SCHEMA_VERSION||value.userId!==userId)return emptyAccount(userId)
  return Object.assign(emptyAccount(userId),clone(value),{
    words:Object.assign({},value.words||{}),blocked:Object.assign({},value.blocked||{}),drafts:Object.assign({},value.drafts||{}),
    queue:Array.isArray(value.queue)?value.queue:[],terminal:Array.isArray(value.terminal)?value.terminal.slice(0,MAX_TERMINAL):[]
  })
}

function createSavedWordSyncManager(options={}) {
  const runtime=options.runtime||(typeof wx==='undefined'?null:wx)
  const api=options.api||require('../../services/api')
  const host=options.host||require('../../services/host')
  const now=options.now||(()=>Date.now())
  const random=options.random||Math.random
  const schedule=options.schedule||((fn,delay)=>setTimeout(fn,delay))
  const cancel=options.cancel||(timer=>clearTimeout(timer))
  const submit=options.submit||(request=>api.savedWordSync(request))
  const applyRemote=options.applyRemote||(word=>applyRemoteToHost(host,word))
  const isAuthenticated=options.isAuthenticated||(()=>api.isAuthenticated())
  const currentUser=options.currentUser||(()=>api.currentUser())
  let activeUserId=null,account=null,busy=false,pendingPull=false,started=false,timer=null
  const subscribers=new Set()
  let currentStatus={status:'idle',pendingCount:0,lastSyncedAt:null,error:null}

  function readStored(userId){try{return normalizeAccount(runtime&&runtime.getStorageSync(keyFor(userId)),userId)}catch(_){return emptyAccount(userId)}}
  function pendingCount(){return account?Object.keys(account.drafts).length+account.queue.reduce((total,batch)=>total+batch.operations.length,0):0}
  function updateStatus(status,error=null){currentStatus={status,pendingCount:pendingCount(),lastSyncedAt:account&&account.lastSyncedAt||null,error};for(const subscriber of [...subscribers])subscriber(Object.assign({},currentStatus))}
  function save(){if(!account||!activeUserId)return;try{runtime&&runtime.setStorageSync(keyFor(activeUserId),clone(account))}catch(_){}updateStatus(currentStatus.status,currentStatus.error)}
  function subscribe(subscriber){subscribers.add(subscriber);subscriber(Object.assign({},currentStatus));return()=>subscribers.delete(subscriber)}

  function activate(userId,settings={}){
    if(typeof userId!=='string'||!userId)return false
    if(timer){cancel(timer);timer=null}
    activeUserId=userId;account=readStored(userId);pendingPull=false
    updateStatus(account.queue.length||Object.keys(account.drafts).length?'pending':'idle')
    if(settings.sync!==false)void trigger('login',true)
    return true
  }
  function deactivate(){if(timer){cancel(timer);timer=null}activeUserId=null;account=null;pendingPull=false;busy=false;updateStatus('idle')}

  function record(action,value,immediate=true){
    if(!activeUserId||!account||!isAuthenticated()||(action!=='save'&&action!=='delete'))return false
    const entry=normalizeEntry(value);if(!entry)return false
    const blocked=account.blocked[entry.entryId]
    if(blocked&&blocked.contentVersion===entry.contentVersion)return false
    const known=account.words[entry.entryId]
    const desiredState=action==='delete'?'deleted':'saved'
    if(!account.drafts[entry.entryId]&&known&&known.state===desiredState&&known.contentVersion===entry.contentVersion)return false
    account.drafts[entry.entryId]=Object.assign({},entry,{action,occurredAt:new Date(now()).toISOString()})
    save();updateStatus(busy?'syncing':'pending')
    if(immediate)void trigger('word-change',true)
    return true
  }

  function retryDelay(attempt){const base=attempt<RETRY_DELAYS_MS.length?RETRY_DELAYS_MS[attempt]:Math.min(MAX_RETRY_MS,RETRY_DELAYS_MS[RETRY_DELAYS_MS.length-1]*Math.pow(2,attempt-RETRY_DELAYS_MS.length+1));return Math.min(MAX_RETRY_MS,Math.round(base+base*.2*Math.max(0,Math.min(1,random()))))}
  function scheduleRetry(error){if(timer)return;const attempt=account.retryAttempt||0,delay=retryDelay(attempt);account.retryAttempt=attempt+1;save();updateStatus('error',error&&error.serverCode||error&&error.kind||'network');timer=schedule(()=>{timer=null;void trigger('retry',true)},delay)}

  function materialize(pull){
    if(!account||account.queue.length)return null
    const keys=Object.keys(account.drafts).sort().slice(0,50)
    if(!keys.length&&!pull)return null
    const operations=keys.map(entryId=>{
      const draft=account.drafts[entryId],known=account.words[entryId]
      const payload=Object.assign({},draft,{baseRevision:known?.revision||'0'})
      return Object.assign({operationId:operationIdFor(payload)},payload)
    })
    const payload={schemaVersion:SCHEMA_VERSION,cursor:account.cursor,operations,limit:100}
    const batch=Object.assign({batchId:batchIdFor(payload)},payload)
    for(const key of keys)delete account.drafts[key]
    account.queue.push(batch);save();return batch
  }

  function rememberTerminal(item){account.terminal=[Object.assign({recordedAt:new Date(now()).toISOString()},item),...account.terminal].slice(0,MAX_TERMINAL)}
  function acceptWord(word){if(!word||!word.entryId)return;account.words[word.entryId]=clone(word);delete account.blocked[word.entryId];applyRemote(word)}
  function handleResponse(batch,response){
    if(!response||response.batchId!==batch.batchId)throw Object.assign(new Error('Saved word sync response batch mismatch'),{retryable:false,kind:'contract'})
    account.queue.shift();account.retryAttempt=0
    const submitted=new Map(batch.operations.map(operation=>[operation.operationId,operation]))
    for(const result of response.operations||[]){
      if(result.word)acceptWord(result.word)
      if(result.status==='rejected'){
        const operation=submitted.get(result.operationId)
        if(operation)account.blocked[result.entryId]={contentVersion:operation.contentVersion,reason:result.reason,recordedAt:new Date(now()).toISOString()}
        rememberTerminal({operationId:result.operationId,entryId:result.entryId,reason:result.reason})
      }
    }
    for(const word of response.changes||[])acceptWord(word)
    account.cursor=response.nextCursor||account.cursor;account.lastSyncedAt=response.serverTime||new Date(now()).toISOString();save()
    return !!response.hasMore
  }

  async function trigger(_reason,pull=true){
    if(!activeUserId||!account||!isAuthenticated()||currentUser()?.userId!==activeUserId)return false
    pendingPull=pendingPull||pull;if(busy)return false
    if(timer){cancel(timer);timer=null}busy=true;updateStatus('syncing')
    try{
      let wantsPull=pendingPull;pendingPull=false
      while(activeUserId&&account&&isAuthenticated()){
        let batch=account.queue[0]||materialize(wantsPull);wantsPull=false;if(!batch)break
        try{
          const response=await submit(clone(batch));const hasMore=handleResponse(batch,response);if(hasMore)wantsPull=true
          if(!account.queue.length&&Object.keys(account.drafts).length)materialize(false);else if(!account.queue.length&&wantsPull)materialize(true)
        }catch(error){
          if(error&&error.kind==='unauthorized'){updateStatus('error','authentication');return false}
          if(error&&error.retryable===false){
            account.queue.shift();const reason=error.serverCode||error.kind||'terminal_error'
            for(const operation of batch.operations)account.blocked[operation.entryId]={contentVersion:operation.contentVersion,reason,recordedAt:new Date(now()).toISOString()}
            rememberTerminal({batchId:batch.batchId,reason});save();continue
          }
          scheduleRetry(error);return false
        }
      }
      updateStatus('synced');return true
    }finally{busy=false;if(pendingPull)void trigger('pending',true)}
  }

  function foreground(){const user=currentUser();if(user&&user.userId&&isAuthenticated()&&activeUserId!==user.userId)activate(user.userId,{sync:false});if(activeUserId)void trigger('foreground',true)}
  function start(){if(started)return;started=true;if(runtime&&typeof runtime.onNetworkStatusChange==='function')runtime.onNetworkStatusChange(result=>{if(result&&result.isConnected&&activeUserId)void trigger('network-restored',true)})}
  function stop(){started=false;deactivate()}
  return {start,stop,activate,deactivate,foreground,trigger,record,saveWord:(entry,immediate=true)=>record('save',entry,immediate),deleteWord:(entry,immediate=true)=>record('delete',entry,immediate),subscribe,status:()=>Object.assign({},currentStatus),_inspect:()=>account?clone(account):null,_retryDelay:retryDelay}
}

function applyRemoteToHost(host,word){
  host.mutate(current=>{
    current.savedWordEntries=Object.assign({},current.savedWordEntries||{})
    current.words=Array.isArray(current.words)?[...current.words]:[]
    if(word.state==='saved'){
      current.savedWordEntries[word.entryId]=Object.assign({},word)
      if(!current.words.includes(word.surface))current.words.push(word.surface)
    }else{
      delete current.savedWordEntries[word.entryId]
      if(!Object.values(current.savedWordEntries).some(entry=>entry.surface===word.surface))current.words=current.words.filter(surface=>surface!==word.surface)
    }
    return current
  })
}

const singleton=createSavedWordSyncManager()
module.exports={
  SCHEMA_VERSION,STORAGE_PREFIX,operationIdFor,batchIdFor,normalizeEntry,createSavedWordSyncManager,
  start:()=>singleton.start(),stop:()=>singleton.stop(),activate:(userId,settings)=>singleton.activate(userId,settings),deactivate:()=>singleton.deactivate(),foreground:()=>singleton.foreground(),trigger:(reason,pull)=>singleton.trigger(reason,pull),saveWord:(entry,immediate)=>singleton.saveWord(entry,immediate),deleteWord:(entry,immediate)=>singleton.deleteWord(entry,immediate),subscribe:subscriber=>singleton.subscribe(subscriber),status:()=>singleton.status()
}
