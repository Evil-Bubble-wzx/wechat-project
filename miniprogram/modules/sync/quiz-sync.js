const attempts=require('../quiz/attempts')
const learningPoints=require('../ranking/learning-points')
const STORAGE_PREFIX='tingyue.quizSync.v1:'
const clone=value=>JSON.parse(JSON.stringify(value))
const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)
const later=(a,b)=>a.length>b.length||(a.length===b.length&&a>b)
const contract=()=>Object.assign(new Error('Invalid Quiz synchronization response'),{kind:'contract',retryable:false})
const payloadKeys=['schemaVersion','attemptId','workId','pieceId','contentVersion','quizVersion','questionIds','selectedOptions','startedAt','submittedAt']
const historyEntry=(history,id)=>Object.prototype.hasOwnProperty.call(history,id)?history[id]:null
function payload(attempt){return payloadKeys.reduce((out,key)=>{out[key]=clone(attempt[key]);return out},{})}
function validAttempt(attempt){
  return !!attempt&&attempts.validate(attempt).valid&&attempt.status==='local_unverified'&&
    typeof attempt.attemptId==='string'&&attempt.attemptId.length>=8&&attempt.attemptId.length<=128&&
    ['workId','pieceId'].every(key=>typeof attempt[key]==='string'&&attempt[key].length<=128)&&
    [attempt.contentVersion,attempt.quizVersion].every(value=>Number.isInteger(value)&&value>0)&&
    attempt.questionIds.length<=100&&attempt.questionIds.every(value=>typeof value==='string'&&value.length>0)&&
    Date.parse(attempt.submittedAt)>=Date.parse(attempt.startedAt)
}
function validEntry(entry){
  return entry?.schemaVersion===1&&typeof entry.attemptId==='string'&&!!entry.attemptId&&
    ['workId','pieceId','title'].every(key=>typeof entry[key]==='string')&&
    [entry.contentVersion,entry.quizVersion].every(value=>Number.isInteger(value)&&value>0)&&
    ['startedAt','submittedAt','serverUpdatedAt'].every(key=>Number.isFinite(Date.parse(entry[key])))&&
    decimal(entry.revision)&&entry.revision!=='0'&&['server_verified','rejected','withdrawn'].includes(entry.status)&&
    [entry.questionCount,entry.correctCount].every(value=>Number.isSafeInteger(value)&&value>=0)&&entry.correctCount<=entry.questionCount&&
    typeof entry.currentCompatible==='boolean'&&
    (entry.status==='server_verified'?(Number.isInteger(entry.score)&&entry.score>=0&&entry.score<=100&&typeof entry.mastery==='boolean'&&Number.isFinite(Date.parse(entry.verifiedAt))):entry.score===null&&entry.mastery===null)
}
function validStored(value,id){
  return value?.schemaVersion===1&&value.userId===id&&Array.isArray(value.queue)&&
    value.queue.every(request=>request&&Object.keys(request).every(key=>payloadKeys.includes(key))&&validAttempt(Object.assign({},request,{status:'local_unverified',score:0,mastery:false})))&&
    value.history&&typeof value.history==='object'&&!Array.isArray(value.history)&&Object.entries(value.history).every(([key,entry])=>key===entry.attemptId&&validEntry(entry))&&
    (value.cursor===null||(typeof value.cursor==='string'&&value.cursor.length<=512))&&(value.summary===null||validSummary(value.summary))
}
function validSummary(summary){
  const trend=summary?.trend,n=summary?.compatibleQuizPieces
  if(!trend||trend.ready!==(n>=6)||trend.remaining!==Math.max(0,6-n)||
    (trend.ready?(![trend.early,trend.recent].every(value=>Number.isInteger(value)&&value>=0&&value<=100)||trend.delta!==trend.recent-trend.early):
      (trend.early!==null||trend.recent!==null||trend.delta!==null)))return false
  return summary?.schemaVersion===1&&summary.source==='server_verified'&&Number.isFinite(Date.parse(summary.asOf))&&
    ['completedPieces','unknownWordPieces','verifiedAttemptCount','compatibleQuizPieces'].every(key=>Number.isSafeInteger(summary[key])&&summary[key]>=0)&&
    summary.unknownWordPieces<=summary.completedPieces&&summary.compatibleQuizPieces<=summary.verifiedAttemptCount&&
    (summary.unknownWordPieces?summary.completedWords===null:summary.completedWords===summary.knownCompletedWords)&&
    decimal(summary.knownCompletedWords)&&decimal(summary.listenedMs)&&
    (summary.averageCorrectPercent===null||(Number.isInteger(summary.averageCorrectPercent)&&summary.averageCorrectPercent>=0&&summary.averageCorrectPercent<=100))&&
    (summary.compatibleQuizPieces===0?summary.averageCorrectPercent===null:summary.averageCorrectPercent!==null)&&
    summary.trend&&typeof summary.trend.ready==='boolean'&&Number.isSafeInteger(summary.trend.remaining)&&summary.trend.remaining>=0&&
    Number.isSafeInteger(summary.trend.pieceCount)&&summary.trend.pieceCount===summary.compatibleQuizPieces&&
    summary.learningScore?.ruleVersion==='learning-points-v2'&&decimal(summary.learningScore.totalPoints)
}
function createQuizSyncManager(options={}){
  const api=options.api||require('../../services/api'),host=options.host||require('../../services/host')
  const runtime=()=>options.runtime||(typeof wx==='undefined'?null:wx)
  const schedule=options.schedule||setTimeout,cancel=options.cancel||clearTimeout
  let userId=null,account=null,generation=0,busy=false,timer=null,retry=0,started=false,pullPending=false
  let status={status:'idle',pendingCount:0,error:null}
  const listeners=new Set()
  const scope=()=>!!userId&&!!account&&api.isAuthenticated()&&api.currentUser()?.userId===userId&&host.accountScope()===userId
  const cloud=()=>typeof api.quizHistoryAvailable==='function'&&api.quizHistoryAvailable()
  function notify(value,error=null){
    status={status:value,pendingCount:account?.queue.length||0,error}
    for(const listener of listeners)listener(Object.assign({},status))
  }
  function save(){
    const storage=runtime()
    if(!storage?.setStorageSync)throw Object.assign(new Error('Quiz queue storage unavailable'),{kind:'storage',retryable:false})
    try{storage.setStorageSync(STORAGE_PREFIX+encodeURIComponent(userId),clone(account))}
    catch(_){throw Object.assign(new Error('Quiz queue storage failed'),{kind:'storage',retryable:false})}
  }
  function project(){
    if(!scope())return
    host.mutate(state=>{
      state.cloudQuizHistory=clone(Object.values(account.history))
      state.cloudLearningSummary=account.summary?clone(account.summary):null
      // Withdrawals override local verified feedback; cloud summaries never fabricate answers.
      state.results=(state.results||[]).map(item=>{
        const remote=historyEntry(account.history,item.attemptId)
        return remote&&remote.status!=='server_verified'?Object.assign({},item,{status:'rejected',cloudStatus:remote.status,error:{code:remote.rejectionCode||'QUIZ_ATTEMPT_REJECTED'}}):item
      })
      if(account.summary)learningPoints.applyConfirmed(state,account.summary.learningScore)
      return state
    })
  }
  function deactivate(){if(timer)cancel(timer);timer=null;generation++;userId=null;account=null;busy=false;pullPending=false;notify('idle')}
  function activate(id,settings={}){
    if(!id||!api.isAuthenticated()||api.currentUser()?.userId!==id||host.accountScope()!==id)return false
    if(userId===id&&account){if(settings.sync!==false)void trigger('activate',true);return true}
    deactivate();userId=id
    let stored
    try{stored=runtime()?.getStorageSync(STORAGE_PREFIX+encodeURIComponent(id))}
    catch(_){account=null;notify('error','storage');return false}
    if(stored&&!validStored(stored,id)){account=null;notify('error','storage');return false}
    account=stored?clone(stored):{schemaVersion:1,userId:id,queue:[],cursor:null,history:{},summary:null}
    // Only this account's previous unverified attempts, never guest records.
    for(const attempt of host.read().results||[])if(validAttempt(attempt)&&!account.queue.some(item=>item.attemptId===attempt.attemptId)&&!historyEntry(account.history,attempt.attemptId))account.queue.push(payload(attempt))
    try{save();project();notify(account.queue.length?'pending':'idle')}catch(error){notify('error',error.kind||'storage');return false}
    if(settings.sync!==false)void trigger('activate',true)
    return true
  }
  function enqueue(attempt,immediate=true){
    if(!scope()||!validAttempt(attempt))return false
    const request=payload(attempt),existing=account.queue.find(item=>item.attemptId===request.attemptId)
    if(existing&&JSON.stringify(existing)!==JSON.stringify(request))return false
    if(!existing)account.queue.push(request)
    try{save()}catch(error){notify('error',error.kind||'storage');return false}
    notify(busy?'syncing':'pending');if(immediate)void trigger('submit',true);return true
  }
  function mergeHistory(target,changes){
    for(const entry of changes){
      if(!validEntry(entry))throw contract()
      const previous=historyEntry(target,entry.attemptId)
      if(!previous||later(entry.revision,previous.revision))Object.defineProperty(target,entry.attemptId,{value:clone(entry),writable:true,enumerable:true,configurable:true})
    }
  }
  async function pull(current){
    let cursor=account.cursor,history=clone(account.history),reset=false
    while(current()){
      let response
      try{response=await api.quizHistory(cursor,100)}catch(error){
        if(!current())return false
        if(cursor&&(error.serverCode||error.code)==='INVALID_REQUEST'&&(error.statusCode===400||error.details?.field==='cursor')&&!reset){cursor=null;history={};reset=true;continue}
        throw error
      }
      if(!current())return false
      if(response?.schemaVersion!==1||!Array.isArray(response.changes)||typeof response.nextCursor!=='string'||!response.nextCursor||
        typeof response.hasMore!=='boolean'||(response.hasMore&&(!response.changes.length||response.nextCursor===cursor)))throw contract()
      mergeHistory(history,response.changes);cursor=response.nextCursor
      // A reset is atomic: keep the previous complete cache until every page arrives.
      if(!reset){account.history=clone(history);account.cursor=cursor;save();project()}
      if(!response.hasMore)break
    }
    if(!current())return false
    account.history=history;account.cursor=cursor;save();project()
    const summary=await api.learningSummary()
    if(!current())return false
    if(!validSummary(summary))throw contract()
    if(!account.summary||Date.parse(summary.asOf)>=Date.parse(account.summary.asOf)){account.summary=clone(summary);save();project()}
    return true
  }
  async function trigger(_reason,pullCloud=true){
    if(!scope())return false
    pullPending=pullPending||pullCloud;if(busy)return false
    if(timer)cancel(timer);timer=null;busy=true;notify('syncing')
    const captured=account,epoch=generation,capturedUser=userId
    const current=()=>epoch===generation&&account===captured&&userId===capturedUser&&scope()
    try{
      let wantsPull=pullPending;pullPending=false
      while(current()){
        while(current()&&account.queue.length){
          // Storage must succeed before every network send, including a retry after quota failure.
          save()
          const request=clone(account.queue[0]),result=await api.submitQuiz(request)
          if(!current())return false
          if(result?.attemptId!==request.attemptId||!['server_verified','rejected'].includes(result.status)||
            (result.status==='server_verified'?(!Number.isInteger(result.score)||result.score<0||result.score>100||typeof result.mastery!=='boolean'||!Number.isFinite(Date.parse(result.verifiedAt))):(!result.error||typeof result.error.code!=='string'||result.error.retryable!==false)))throw contract()
          host.mutate(state=>{
            state.results=(state.results||[]).map(item=>item.attemptId===request.attemptId?Object.assign({},item,clone(result)):item)
            learningPoints.applyConfirmed(state,result.learningScore);return state
          })
          account.queue.shift();save();retry=0;notify('syncing');wantsPull=true
        }
        if(!current())return false
        if(wantsPull&&cloud()){if(!await pull(current))return false}
        if(!pullPending)break
        wantsPull=pullPending;pullPending=false
      }
      retry=0;notify(cloud()?'synced':'local');return true
    }catch(error){
      if(!current())return false
      notify('error',error.kind||error.code||'network')
      if(error.retryable!==false&&error.kind!=='unauthorized'){
        timer=schedule(()=>{timer=null;void trigger('retry',true)},Math.min(300000,1000*Math.pow(2,Math.min(retry++,9))))
        if(timer?.unref)timer.unref()
      }
      return false
    }finally{
      if(epoch===generation){busy=false;if(pullPending&&status.status!=='error')void trigger('pending',true)}
    }
  }
  function foreground(){
    const id=api.currentUser()?.userId
    if(api.isAuthenticated()&&id&&host.accountScope()===id){if(activate(id,{sync:false}))void trigger('foreground',true)}
    else deactivate()
  }
  function start(){if(started)return;started=true;runtime()?.onNetworkStatusChange?.(result=>{if(result?.isConnected)foreground()})}
  function subscribe(listener){listeners.add(listener);listener(Object.assign({},status));return()=>listeners.delete(listener)}
  return {activate,deactivate,enqueue,trigger,foreground,start,subscribe,status:()=>Object.assign({},status),_inspect:()=>account?clone(account):null}
}
const singleton=createQuizSyncManager()
module.exports={STORAGE_PREFIX,validAttempt,validEntry,validSummary,createQuizSyncManager,
  activate:(id,settings)=>singleton.activate(id,settings),deactivate:()=>singleton.deactivate(),
  enqueue:(attempt,immediate)=>singleton.enqueue(attempt,immediate),trigger:(reason,pull)=>singleton.trigger(reason,pull),
  foreground:()=>singleton.foreground(),start:()=>singleton.start(),subscribe:listener=>singleton.subscribe(listener),status:()=>singleton.status()}
