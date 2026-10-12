const {canonicalStringify,sha256}=require('./local-import')
const STORAGE_PREFIX='tingyue.librarySync.v1:'
const clone=value=>JSON.parse(JSON.stringify(value))
const operationIdFor=payload=>'library-op-v1:'+sha256(canonicalStringify(payload))
const empty=userId=>({schemaVersion:1,userId,cursor:null,entries:{},drafts:{},queue:[],terminal:[],sequence:0,migrated:false})

function createLibrarySyncManager(options={}){
  const runtime=options.runtime||(typeof wx==='undefined'?null:wx)
  const api=options.api||require('../../services/api'),host=options.host||require('../../services/host')
  const now=options.now||(()=>Date.now()),random=options.random||Math.random
  const schedule=options.schedule||((fn,delay)=>setTimeout(fn,delay)),cancel=options.cancel||clearTimeout
  const submit=options.submit||(batch=>api.librarySync(batch))
  let account=null,userId=null,generation=0,busy=false,timer=null,pullPending=false,retry=0,started=false
  let status={status:'idle',pendingCount:0,error:null}
  const subscribers=new Set()
  const scope=()=>!!userId&&api.isAuthenticated()&&api.currentUser()?.userId===userId&&host.accountScope()===userId
  const supported=()=>typeof api.librarySyncAvailable!=='function'||api.librarySyncAvailable()
  function notify(value,error=null){
    status={status:value,pendingCount:account?Object.keys(account.drafts).length+account.queue.reduce((sum,batch)=>sum+batch.operations.length,0):0,error}
    for(const listener of subscribers)listener(Object.assign({},status))
  }
  function save(){if(account&&runtime)runtime.setStorageSync(STORAGE_PREFIX+encodeURIComponent(userId),clone(account))}
  function project(){
    if(!scope())return
    const entries=clone(account.entries)
    const pending=[...account.queue.flatMap(batch=>batch.operations),...Object.values(account.drafts)]
    for(const op of pending){
      const entry=entries[op.workId]||(entries[op.workId]={workId:op.workId,favorite:false,lastOpenedAt:null})
      if(op.action==='favorite'||op.action==='unfavorite')entry.favorite=op.action==='favorite'
      else if(!entry.lastOpenedAt||op.occurredAt>entry.lastOpenedAt)entry.lastOpenedAt=op.occurredAt
    }
    host.mutate(state=>{
      state.favorites=Object.values(entries).filter(entry=>entry.favorite).map(entry=>entry.workId)
      const ordered=Object.values(entries).filter(entry=>entry.lastOpenedAt).sort((a,b)=>b.lastOpenedAt.localeCompare(a.lastOpenedAt)||a.workId.localeCompare(b.workId)).map(entry=>entry.workId)
      state.recent=[...ordered,...(state.recent||[]).filter(id=>!ordered.includes(id))].slice(0,30)
      return state
    })
  }
  function deactivate(){if(timer)cancel(timer);timer=null;generation++;account=null;userId=null;busy=false;pullPending=false;notify('idle')}
  function activate(id,settings={}){
    if(!id||typeof id!=='string'||!supported())return false
    if(id===userId&&account){if(settings.sync!==false)void trigger('activate',true);return true}
    deactivate();userId=id
    let stored;try{stored=runtime&&runtime.getStorageSync(STORAGE_PREFIX+encodeURIComponent(id))}catch(_){}
    account=stored?.schemaVersion===1&&stored.userId===id?Object.assign(empty(id),clone(stored)):empty(id)
    if(scope()&&!account.migrated){
      for(const workId of host.read().favorites||[])record('favorite',workId,false)
      account.migrated=true;save()
    }
    project();notify(Object.keys(account.drafts).length||account.queue.length?'pending':'idle')
    if(settings.sync!==false)void trigger('activate',true)
    return true
  }
  function record(action,workId,immediate=true){
    if(!scope()||!supported()||!['favorite','unfavorite','open'].includes(action)||typeof workId!=='string'||!workId||workId.length>128)return false
    const key=workId+':'+(action==='open'?'open':'favorite')
    account.drafts[key]={workId,action,occurredAt:new Date(now()).toISOString()}
    save();project();notify(busy?'syncing':'pending')
    if(immediate)void trigger('change',true)
    return true
  }
  function materialize(pull){
    const keys=Object.keys(account.drafts).sort().slice(0,50)
    if(!keys.length&&!pull)return null
    const operations=keys.map(key=>{
      const draft=account.drafts[key],payload=Object.assign({},draft,{baseRevision:account.entries[draft.workId]?.favoriteRevision||'0'})
      delete account.drafts[key]
      return Object.assign({operationId:operationIdFor(payload)},payload)
    })
    account.sequence=(Number(account.sequence)||0)+1
    // Empty pulls need a fresh identity even when their cursor has not advanced.
    const batch={schemaVersion:1,batchId:'library-'+now().toString(36)+'-'+random().toString(36).slice(2,12)+'-'+account.sequence,cursor:account.cursor,operations,limit:100}
    account.queue.push(batch);save();return batch
  }
  async function trigger(_reason,pull=true){
    if(!scope()||!supported())return false
    pullPending=pullPending||pull;if(busy)return false
    if(timer)cancel(timer);timer=null;busy=true;notify('syncing')
    const captured=account,epoch=generation,capturedUser=userId
    const current=()=>generation===epoch&&account===captured&&userId===capturedUser&&scope()
    try{
      let wantsPull=pullPending;pullPending=false
      while(current()){
        const queued=account.queue[0],batch=queued||materialize(wantsPull)
        if(!queued)wantsPull=false
        if(!batch)break
        const response=await submit(clone(batch))
        if(!current())return false
        if(!response||response.schemaVersion!==1||response.batchId!==batch.batchId||typeof response.nextCursor!=='string'||!Array.isArray(response.changes)||!Array.isArray(response.operations))throw Object.assign(new Error('Invalid library response'),{kind:'contract',retryable:false})
        if(response.operations.length!==batch.operations.length||response.operations.some((item,index)=>item.operationId!==batch.operations[index].operationId))throw Object.assign(new Error('Incomplete library acknowledgement'),{kind:'contract',retryable:false})
        for(const result of response.operations){
          if(result.entry)account.entries[result.entry.workId]=clone(result.entry)
          if(result.status==='rejected'||result.reason==='stale_favorite_blocked_by_delete')account.terminal=[{operationId:result.operationId,reason:result.reason},...account.terminal].slice(0,20)
        }
        for(const entry of response.changes)account.entries[entry.workId]=clone(entry)
        account.queue.shift();account.cursor=response.nextCursor;retry=0;save();project()
        wantsPull=wantsPull||!!response.hasMore
        if(pullPending){wantsPull=true;pullPending=false}
      }
      notify(account.terminal.length?'attention':'synced');return true
    }catch(error){
      if(!current())return false
      notify('error',error.kind||'network')
      if(error.retryable!==false&&error.kind!=='unauthorized'){
        const delay=Math.min(300_000,1000*Math.pow(2,Math.min(retry++,9)))
        timer=schedule(()=>{timer=null;void trigger('retry',true)},delay)
        if(timer&&typeof timer.unref==='function')timer.unref()
      }
      // Keep the immutable batch for explicit retry or account reactivation.
      return false
    }finally{if(generation===epoch){busy=false;if(pullPending&&status.status!=='error')void trigger('pending',true)}}
  }
  function foreground(){const id=api.currentUser()?.userId;if(supported()&&api.isAuthenticated()&&id){activate(id,{sync:false});void trigger('foreground',true)}}
  function start(){if(started)return;started=true;if(runtime?.onNetworkStatusChange)runtime.onNetworkStatusChange(result=>{if(result?.isConnected)foreground()})}
  const subscribe=fn=>{subscribers.add(fn);fn(Object.assign({},status));return()=>subscribers.delete(fn)}
  return {activate,deactivate,foreground,trigger,record,start,subscribe,status:()=>Object.assign({},status),_inspect:()=>account?clone(account):null}
}
const singleton=createLibrarySyncManager()
module.exports={STORAGE_PREFIX,operationIdFor,createLibrarySyncManager,
  activate:(id,settings)=>singleton.activate(id,settings),deactivate:()=>singleton.deactivate(),foreground:()=>singleton.foreground(),
  trigger:(reason,pull)=>singleton.trigger(reason,pull),record:(action,id,immediate)=>singleton.record(action,id,immediate),
  start:()=>singleton.start(),subscribe:fn=>singleton.subscribe(fn),status:()=>singleton.status()}
