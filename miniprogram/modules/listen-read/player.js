// BackgroundAudioManager and this module are the single source of truth for
// playback. Progress has two independent meanings: the visible cursor and a
// trusted checkpoint backed by continuous playback plus merged listened ranges.
const host = require('../../services/host')
const progressSync = require('../sync/progress-sync')
const audioLease = require('./audio-lease')

const PROGRESS_SCHEMA_VERSION = 2
const COMPLETION_COVERAGE = .9
const COMPLETION_TAIL_SECONDS = 3
const CHECKPOINT_TRUST_SECONDS = 5
const SAVE_INTERVAL_MS = 5000
const MAX_SAMPLE_WALL_SECONDS = 30
const MIN_RATE = .75

let context
let renewal = null
let sourceResolver = null
let playIntent = false
let automaticRecoveryUsed = false
let leaseFailed = false
let backgroundBound = false
let sessionSequence = 0
let anchor = null
let pendingSeek = null
let pendingListenSeconds = 0
let lastPersistAt = 0
let requestedPauseReason = null
let waitingWasPlaying = false
let suppressNextPause = false
let now = () => Date.now()
const subscribers = new Set()
const initialState = () => ({ accountScope:null, sessionId:0, workId:null, pieceId:null, source:'', book:null, contentVersion:null, position:0, checkpointPosition:0, duration:0, rate:1, status:'idle', pauseReason:null, loop:false, completed:false, listenedRanges:[], coverage:0, error:null })
let state = initialState()

const pieceId = book => book && (book.chapterId || book.pieceId || book.id)
const sourceFor = book => book && (book.localAudio || (wx.isBrowserPreview && book.previewAudioUrl ? book.previewAudioUrl : book.audioUrl))
const sourceIdentity = source => String(source||'').split(/[?#]/)[0]
// A content version is immutable; expiring transport signatures are not its identity.
const audioKeyFor = book => [pieceId(book)||'',book&&book.contentVersion?'v'+book.contentVersion:sourceIdentity(sourceFor(book))].join('|')
function compatibleAudioKey(key,book){
  if(!key||key===audioKeyFor(book))return true
  const legacyPrefix=String(book&&book.contentVersion||0)+'|'
  if(!String(key).startsWith(legacyPrefix))return false
  return !!(book&&book.contentVersion)||sourceIdentity(String(key).slice(legacyPrefix.length))===sourceIdentity(sourceFor(book))
}
const scopeCurrent = () => state.accountScope===host.accountScope()
const snapshot = () => Object.assign({},state,{sourceRenewing:!!renewal,book:state.book?Object.assign({},state.book):null,listenedRanges:state.listenedRanges.map(range=>range.slice())})
function notify(){const value=snapshot();for(const subscriber of [...subscribers])subscriber(value)}
function update(patch){state=Object.assign({},state,patch);notify();return snapshot()}
const pad2 = n => String(n).padStart(2,'0')
const dayKey = (date=new Date()) => date.getFullYear()+'-'+pad2(date.getMonth()+1)+'-'+pad2(date.getDate())
const clamp = (value,min,max) => Math.max(min,Math.min(Number(value)||0,max))

function normalizeRanges(input,duration){
  const ranges=(Array.isArray(input)?input:[]).map(range=>[clamp(range&&range[0],0,duration),clamp(range&&range[1],0,duration)]).filter(range=>range[1]>range[0]).sort((a,b)=>a[0]-b[0])
  const merged=[]
  for(const range of ranges){const last=merged[merged.length-1];if(last&&range[0]<=last[1]+.05)last[1]=Math.max(last[1],range[1]);else merged.push(range)}
  return merged
}
function addRange(ranges,start,end,duration){return normalizeRanges([...ranges,[start,end]],duration)}
const rangeSeconds = ranges => ranges.reduce((total,range)=>total+range[1]-range[0],0)
const coverageFor = (ranges,duration) => duration>0?Math.min(1,rangeSeconds(ranges)/duration):0
function tailCovered(ranges,duration){const start=Math.max(0,duration-COMPLETION_TAIL_SECONDS);return ranges.some(range=>range[0]<=start+.05&&range[1]>=duration-.25)}
function progressFor(book){
  const duration=Number(book.duration)||0,stored=(host.read().progress||{})[pieceId(book)]||{}
  const durationMatches=!stored.duration||!duration||Math.abs(Number(stored.duration)-duration)<=.5
  const compatible=stored.schemaVersion===PROGRESS_SCHEMA_VERSION&&durationMatches&&compatibleAudioKey(stored.audioKey,book)&&(!stored.contentVersion||stored.contentVersion===book.contentVersion)
  if(!compatible)return {position:0,checkpointPosition:0,completed:false,listenedRanges:[]}
  const listenedRanges=normalizeRanges(stored.listenedRanges,duration),completed=!!stored.completed
  const checkpointPosition=completed?0:clamp(stored.checkpointSeconds,0,Math.max(0,duration-.25))
  return {position:checkpointPosition,checkpointPosition,completed,listenedRanges}
}
function persist(force=false){
  if(!state.pieceId||!scopeCurrent())return
  const at=now();if(!force&&at-lastPersistAt<SAVE_INTERVAL_MS)return
  const listenAdd=pendingListenSeconds;pendingListenSeconds=0;lastPersistAt=at
  const entry={seconds:state.position,checkpointSeconds:state.checkpointPosition,completed:state.completed,duration:state.duration,listenedRanges:state.listenedRanges.map(range=>range.map(value=>Math.round(value*1000)/1000)),listenedSeconds:Math.round(rangeSeconds(state.listenedRanges)*1000)/1000,coverage:Math.round(state.coverage*10000)/10000,completionReason:state.completed?'coverage_and_ended':null,contentVersion:state.contentVersion,audioKey:audioKeyFor(state.book),schemaVersion:PROGRESS_SCHEMA_VERSION,updatedAt:new Date(at).toISOString()}
  host.mutate(current=>{
    current.progress=Object.assign({},current.progress||{})
    const previous=current.progress[state.pieceId]||{}
    const sameVersion=previous.schemaVersion===PROGRESS_SCHEMA_VERSION&&compatibleAudioKey(previous.audioKey,state.book)&&(!previous.contentVersion||previous.contentVersion===entry.contentVersion)&&(!previous.duration||Math.abs(Number(previous.duration)-entry.duration)<=.5)
    entry.completed=!!((sameVersion&&previous.completed)||entry.completed)
    if(sameVersion&&previous.completed)entry.completionReason=previous.completionReason||'coverage_and_ended'
    current.progress[state.pieceId]=entry
    if(listenAdd>0){
      const key=dayKey(new Date(at))+':'+state.pieceId
      current.listenDaily=Object.assign({},current.listenDaily||{})
      const used=Number(current.listenDaily[key])||0,dailyCap=(state.duration||0)/MIN_RATE*1.2,accepted=Math.min(listenAdd,Math.max(0,dailyCap-used))
      if(accepted>0){current.listeningSec=(Number(current.listeningSec)||0)+accepted;current.listenDaily[key]=used+accepted}
    }
    current.progressSchemaVersion=PROGRESS_SCHEMA_VERSION
    progressSync.capture(current,state.pieceId,entry,{immediate:force})
    return current
  })
  progressSync.kick()
}
function clearAnchor(){anchor=null}
function beginAnchor(position){if(state.status==='playing')anchor={sessionId:state.sessionId,pieceId:state.pieceId,source:state.source,position:Number(position)||0,at:now(),rate:state.rate,continuous:0}}
function sampleContext(force=false){
  if(!context||!state.pieceId||!scopeCurrent())return
  const position=Number(context.currentTime)||0
  if(renewal||state.status==='error'||position<state.position-.25){persist(force);return}
  sample(position,force)
}
function sample(position,forcePersist=false){
  if(!scopeCurrent()||renewal)return
  const currentPosition=clamp(position,0,state.duration||Number.MAX_SAFE_INTEGER)
  if(anchor&&anchor.sessionId===state.sessionId&&anchor.pieceId===state.pieceId&&anchor.source===state.source&&state.status==='playing'){
    const at=now(),wall=(at-anchor.at)/1000,media=currentPosition-anchor.position,expected=wall*(anchor.rate||1),tolerance=Math.max(1.5,expected*.5)
    if(wall>0&&wall<=MAX_SAMPLE_WALL_SECONDS&&media>0&&Math.abs(media-expected)<=tolerance){
      const listenedRanges=addRange(state.listenedRanges,anchor.position,currentPosition,state.duration),continuous=anchor.continuous+wall
      pendingListenSeconds+=wall
      state=Object.assign({},state,{position:currentPosition,listenedRanges,coverage:coverageFor(listenedRanges,state.duration),checkpointPosition:continuous>=CHECKPOINT_TRUST_SECONDS?currentPosition:state.checkpointPosition})
      anchor={sessionId:state.sessionId,pieceId:state.pieceId,source:state.source,position:currentPosition,at,rate:state.rate,continuous}
    }else{
      state=Object.assign({},state,{position:currentPosition})
      anchor={sessionId:state.sessionId,pieceId:state.pieceId,source:state.source,position:currentPosition,at,rate:state.rate,continuous:0}
    }
  }else state=Object.assign({},state,{position:currentPosition})
  persist(forcePersist);notify()
}
function applyPendingSeek(){
  if(!context||pendingSeek===null)return false
  const target=clamp(pendingSeek,0,state.duration||Number.MAX_SAFE_INTEGER);pendingSeek=null
  clearAnchor();state=Object.assign({},state,{position:target})
  try{context.seek(target)}catch(_){return false}
  return true
}

function onTimeUpdate(){
  if(!context||!state.pieceId||!scopeCurrent()||renewal||state.status==='error')return
  const duration=Number.isFinite(context.duration)&&context.duration>0?context.duration:state.duration
  if(duration!==state.duration)state=Object.assign({},state,{duration})
  if(pendingSeek!==null&&duration>0){applyPendingSeek();notify();return}
  sample(Number(context.currentTime)||0,false)
}
function onPlay(){
  if(!state.pieceId)return
  if(scopeCurrent()&&!renewal&&!leaseFailed&&state.status==='paused'&&['system','system_stop'].includes(state.pauseReason))playIntent=true
  if(!scopeCurrent()||!playIntent||renewal){suppressNextPause=true;context?.pause();return}
  requestedPauseReason=null;state=Object.assign({},state,{status:'playing',pauseReason:null,error:null});if(pendingSeek===null)beginAnchor(context&&context.currentTime);notify()
}
function onPause(){if(suppressNextPause){suppressNextPause=false;requestedPauseReason=null;clearAnchor();return}if(!scopeCurrent())return;playIntent=false;if(state.pieceId&&state.status!=='ended'&&state.status!=='error'){sampleContext(true);const pauseReason=requestedPauseReason||(renewal?state.pauseReason:null)||'system';requestedPauseReason=null;clearAnchor();update({status:'paused',pauseReason})}}
function onStop(){if(!scopeCurrent())return;playIntent=false;if(state.pieceId){sampleContext(true);requestedPauseReason=null;clearAnchor();update({status:'paused',pauseReason:'system_stop'})}}
function onEnded(){
  if(!state.pieceId||!scopeCurrent()||renewal||!playIntent)return
  const duration=Number.isFinite(context&&context.duration)&&context.duration>0?context.duration:state.duration
  sample(duration,false)
  const completed=state.completed||(state.coverage>=COMPLETION_COVERAGE&&tailCovered(state.listenedRanges,duration))
  playIntent=state.loop;clearAnchor();state=Object.assign({},state,{position:duration,duration,completed,status:state.loop?'playing':'ended',pauseReason:null});persist(true);notify()
  if(state.loop&&context){pendingSeek=0;applyPendingSeek();context.play()}
}
function audioErrorMessage(error){
  if(!error)return 'audio_error'
  if(typeof error==='string')return error
  const code=error.errCode!==undefined?error.errCode:error.code
  const message=error.errMsg||error.message
  if(code!==undefined&&message)return String(code)+': '+message
  if(message)return String(message)
  if(code!==undefined)return 'audio_error '+String(code)
  try{const serialized=JSON.stringify(error);return serialized&&serialized!=='{}'?serialized:'audio_error'}catch(_){return 'audio_error'}
}
function onError(error){
  if(!state.pieceId||!scopeCurrent()||renewal)return
  sampleContext(true);clearAnchor()
  if(playIntent&&audioLease.lease(state.book)&&!automaticRecoveryUsed){renewSource();return}
  leaseFailed=!!audioLease.lease(state.book);playIntent=false;update({status:'error',error:audioErrorMessage(error)})
}
function onSeeking(){if(context&&state.pieceId)sampleContext(true);clearAnchor()}
function onSeeked(){if(!context||!state.pieceId||!scopeCurrent()||renewal)return;const position=Number(context.currentTime)||0;pendingSeek=null;state=Object.assign({},state,{position});persist(true);if(state.status==='playing')beginAnchor(position);notify()}
function onWaiting(){if(!scopeCurrent()||renewal)return;waitingWasPlaying=state.status==='playing';if(context&&state.pieceId)sampleContext(true);clearAnchor();if(waitingWasPlaying)update({status:'loading'})}
function onCanplay(){if(!state.pieceId||!scopeCurrent()||renewal)return;if(pendingSeek!==null)applyPendingSeek();if(waitingWasPlaying){waitingWasPlaying=false;state=Object.assign({},state,{status:'playing'});beginAnchor(context&&context.currentTime)}notify()}

function bindBackground(ctx){
  if(backgroundBound)return
  ctx.onTimeUpdate(onTimeUpdate);ctx.onEnded(onEnded);ctx.onError(onError)
  if(typeof ctx.onPlay==='function')ctx.onPlay(onPlay)
  if(typeof ctx.onPause==='function')ctx.onPause(onPause)
  if(typeof ctx.onStop==='function')ctx.onStop(onStop)
  if(typeof ctx.onSeeking==='function')ctx.onSeeking(onSeeking)
  if(typeof ctx.onSeeked==='function')ctx.onSeeked(onSeeked)
  if(typeof ctx.onWaiting==='function')ctx.onWaiting(onWaiting)
  if(typeof ctx.onCanplay==='function')ctx.onCanplay(onCanplay)
  backgroundBound=true
}
function ensureContext(){if(!context){context=wx.getBackgroundAudioManager();bindBackground(context)}return context}
function metadata(book,ctx){ctx.title=book.chapterTitle||book.title;ctx.singer=book.narrator||book.author;if(book.coverUrl||book.cover)ctx.coverImgUrl=book.coverUrl||book.cover}
function newSession(book,status){
  const restored=progressFor(book),source=sourceFor(book)
  sessionSequence++;renewal=null;playIntent=false;automaticRecoveryUsed=false;leaseFailed=false;waitingWasPlaying=false;anchor=null;pendingSeek=null;pendingListenSeconds=0;lastPersistAt=now()
  state={accountScope:host.accountScope(),sessionId:sessionSequence,workId:book.workId||book.id,pieceId:pieceId(book),source,book:Object.assign({},book),contentVersion:book.contentVersion||null,position:restored.position,checkpointPosition:restored.checkpointPosition,duration:Number(book.duration)||0,rate:state.rate||1,status:status||'paused',pauseReason:status==='paused'?'selection':null,loop:false,completed:restored.completed,listenedRanges:restored.listenedRanges,coverage:coverageFor(restored.listenedRanges,Number(book.duration)||0),error:null}
  notify();return source
}
function selectTrack(book){
  const source=sourceFor(book);if(!source)return false
  if(scopeCurrent()&&state.book&&audioKeyFor(state.book)===audioKeyFor(book)){
    const replacesRenewal=!!renewal&&source!==state.source&&!!audioLease.lease(book)&&book.audioAccountScope===state.accountScope
    const restored=progressFor(book),duration=state.duration||Number(book.duration)||0
    const listenedRanges=normalizeRanges([...state.listenedRanges,...restored.listenedRanges],duration)
    const restorePosition=state.status==='paused'&&state.pauseReason==='selection'&&state.position===0
    state=Object.assign({},state,{source,book:Object.assign({},book),listenedRanges,coverage:coverageFor(listenedRanges,duration),completed:state.completed||restored.completed,checkpointPosition:Math.max(state.checkpointPosition,restored.checkpointPosition),position:restorePosition?restored.position:state.position})
    // Keep an already playing stream alive; the renewed URL is used on the next resume.
    if(anchor)anchor.source=source
    if(replacesRenewal){renewal=null;leaseFailed=false;if(playIntent)startPlayback(book,true);else update({status:'paused',pauseReason:state.pauseReason||'user'})}
    notify();return true
  }
  if(context&&state.pieceId){sampleContext(true);if(state.status==='playing')context.pause()}
  newSession(book,'paused');return true
}
function startPlayback(book,reload=false){
  const ctx=ensureContext(),source=sourceFor(book)
  state=Object.assign({},state,{source,book:Object.assign({},book),error:null})
  metadata(book,ctx);ctx.playbackRate=state.rate
  if(state.status==='ended'){state=Object.assign({},state,{position:state.completed?0:state.checkpointPosition})}
  pendingSeek=state.position>0||ctx.src===source&&ctx.currentTime>0?state.position:null
  if('startTime' in ctx)ctx.startTime=state.position
  if(!reload&&ctx.src===source){applyPendingSeek();ctx.play();update({status:'playing',pauseReason:null})}
  else{update({status:'loading',pauseReason:null});ctx.src=source;ctx.play()}
  return true
}
function renewSource(){
  if(renewal)return true
  const token={sessionId:state.sessionId,accountScope:state.accountScope,key:audioKeyFor(state.book)}
  const requestedBook=Object.assign({},state.book)
  renewal=token;automaticRecoveryUsed=true;waitingWasPlaying=false;clearAnchor();persist(true)
  update({status:'renewing',pauseReason:null,error:null})
  const current=()=>renewal===token&&state.sessionId===token.sessionId&&state.accountScope===token.accountScope&&scopeCurrent()&&audioKeyFor(state.book)===token.key
  Promise.resolve().then(()=>current()?(sourceResolver||audioLease.renew)(requestedBook):null).then(book=>{
    if(!current())return
    if(!book||audioKeyFor(book)!==token.key||!sourceFor(book)||book.audioAccountScope!==token.accountScope)throw Object.assign(new Error('AUDIO_LEASE_IDENTITY_CHANGED'),{kind:'content'})
    renewal=null;leaseFailed=false
    state=Object.assign({},state,{source:sourceFor(book),book:Object.assign({},book),error:null})
    if(playIntent)startPlayback(book,true)
    else update({status:'paused',pauseReason:state.pauseReason||'user'})
  }).catch(error=>{
    if(!current())return
    renewal=null;leaseFailed=true;playIntent=false;waitingWasPlaying=false;clearAnchor()
    const denied=['CONTENT_VERSION_UNAVAILABLE','CONTENT_ACCESS_DENIED','RESOURCE_NOT_FOUND','AUDIO_ACCOUNT_CHANGED','AUDIO_LEASE_IDENTITY_CHANGED'].includes(error.serverCode||error.code)
    update({status:'error',pauseReason:denied?'content_unavailable':'renewal_failed',error:denied?'audio_content_unavailable':'audio_renewal_failed'})
  })
  return true
}
function playTrack(book){
  const source=sourceFor(book);if(!source)return false
  if(audioLease.lease(book)&&(!book.audioAccountScope||book.audioAccountScope!==host.accountScope())){
    playIntent=false;clearAnchor();if(context){suppressNextPause=true;context.pause()}
    update({status:'error',pauseReason:'account_changed',error:'audio_account_changed'});return false
  }
  const same=scopeCurrent()&&state.book&&audioKeyFor(state.book)===audioKeyFor(book)
  if(!same){if(context&&state.pieceId){sampleContext(true);suppressNextPause=true;context.pause()}newSession(book,'loading')}
  else if(!renewal)state=Object.assign({},state,{source,book:Object.assign({},book),duration:Number(state.duration)||Number(book.duration)||0,error:null})
  playIntent=true
  if(renewal){update({status:'renewing',pauseReason:null});return true}
  automaticRecoveryUsed=false
  if(audioLease.expired(book,now())||(audioLease.lease(book)&&(state.status==='error'||leaseFailed)))return renewSource()
  return startPlayback(book)
}
function pause(reason='user'){playIntent=false;waitingWasPlaying=false;if(!state.pieceId)return;sampleContext(true);requestedPauseReason=reason;clearAnchor();state=Object.assign({},state,{status:'paused',pauseReason:reason});if(context)context.pause();notify()}
function resume(){if(!state.pieceId||!state.source)return false;return playTrack(state.book)}
function seek(seconds){
  if(!state.pieceId)return
  sampleContext(true)
  const position=clamp(seconds,0,state.duration||Number.MAX_SAFE_INTEGER)
  clearAnchor();pendingSeek=null;state=Object.assign({},state,{position})
  if(context&&!renewal&&state.status!=='error')context.seek(position)
  persist(true);if(state.status==='playing')beginAnchor(position);notify()
}
function setRate(value){const rate=Number(value)||1;if(context&&state.pieceId)sampleContext(true);state=Object.assign({},state,{rate});if(context)context.playbackRate=rate;if(state.status==='playing')beginAnchor(context&&context.currentTime);notify()}
function setLoop(loop){update({loop:!!loop})}
function saveNow(){if(!state.pieceId)return;if(context)sampleContext(true);else persist(true)}
function reloadScope(){playIntent=false;renewal=null;if(!state.book)return snapshot();if(context&&state.pieceId){suppressNextPause=true;context.pause()}return newSession(state.book,'paused')}
function subscribe(subscriber){subscribers.add(subscriber);subscriber(snapshot());return()=>subscribers.delete(subscriber)}
function resetForTests(){renewal=null;sourceResolver=null;playIntent=false;automaticRecoveryUsed=false;leaseFailed=false;context=null;backgroundBound=false;sessionSequence=0;anchor=null;pendingSeek=null;pendingListenSeconds=0;lastPersistAt=0;requestedPauseReason=null;waitingWasPlaying=false;suppressNextPause=false;now=()=>Date.now();subscribers.clear();state=initialState()}
function setNowForTests(fn){now=fn}

module.exports={snapshot,subscribe,selectTrack,playTrack,play:playTrack,pause,resume,seek,setRate,rate:setRate,setLoop,saveNow,reloadScope,_resetForTests:resetForTests,_setNowForTests:setNowForTests,_setSourceResolverForTests:fn=>{sourceResolver=fn},_constants:{PROGRESS_SCHEMA_VERSION,COMPLETION_COVERAGE,COMPLETION_TAIL_SECONDS,CHECKPOINT_TRUST_SECONDS}}
