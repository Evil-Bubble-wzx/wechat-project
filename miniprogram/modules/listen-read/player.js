// BackgroundAudioManager and this module are the single source of truth for
// playback. Progress has two independent meanings: the visible cursor and a
// trusted checkpoint backed by continuous playback plus merged listened ranges.
const host = require('../../services/host')

const PROGRESS_SCHEMA_VERSION = 2
const COMPLETION_COVERAGE = .9
const COMPLETION_TAIL_SECONDS = 3
const CHECKPOINT_TRUST_SECONDS = 5
const SAVE_INTERVAL_MS = 5000
const MAX_SAMPLE_WALL_SECONDS = 30
const MIN_RATE = .75

let context
let backgroundBound = false
let sessionSequence = 0
let anchor = null
let pendingSeek = null
let pendingListenSeconds = 0
let lastPersistAt = 0
let requestedPauseReason = null
let waitingWasPlaying = false
let now = () => Date.now()
const subscribers = new Set()
const initialState = () => ({ sessionId:0, workId:null, pieceId:null, source:'', book:null, contentVersion:null, position:0, checkpointPosition:0, duration:0, rate:1, status:'idle', pauseReason:null, loop:false, completed:false, listenedRanges:[], coverage:0, error:null })
let state = initialState()

const pieceId = book => book && (book.chapterId || book.pieceId || book.id)
const sourceFor = book => book && (book.localAudio || (wx.isBrowserPreview && book.previewAudioUrl ? book.previewAudioUrl : book.audioUrl))
const audioKeyFor = book => [book&&book.contentVersion||0,sourceFor(book)||''].join('|')
const snapshot = () => Object.assign({},state,{book:state.book?Object.assign({},state.book):null,listenedRanges:state.listenedRanges.map(range=>range.slice())})
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
  const compatible=stored.schemaVersion===PROGRESS_SCHEMA_VERSION&&durationMatches&&(!stored.audioKey||stored.audioKey===audioKeyFor(book))&&(!stored.contentVersion||stored.contentVersion===book.contentVersion)
  if(!compatible)return {position:0,checkpointPosition:0,completed:false,listenedRanges:[]}
  const listenedRanges=normalizeRanges(stored.listenedRanges,duration),completed=!!stored.completed
  const checkpointPosition=completed?0:clamp(stored.checkpointSeconds,0,Math.max(0,duration-.25))
  return {position:checkpointPosition,checkpointPosition,completed,listenedRanges}
}
function persist(force=false){
  if(!state.pieceId)return
  const at=now();if(!force&&at-lastPersistAt<SAVE_INTERVAL_MS)return
  const listenAdd=pendingListenSeconds;pendingListenSeconds=0;lastPersistAt=at
  const entry={seconds:state.position,checkpointSeconds:state.checkpointPosition,completed:state.completed,duration:state.duration,listenedRanges:state.listenedRanges.map(range=>range.map(value=>Math.round(value*1000)/1000)),listenedSeconds:Math.round(rangeSeconds(state.listenedRanges)*1000)/1000,coverage:Math.round(state.coverage*10000)/10000,completionReason:state.completed?'coverage_and_ended':null,contentVersion:state.contentVersion,audioKey:audioKeyFor(state.book),schemaVersion:PROGRESS_SCHEMA_VERSION,updatedAt:new Date(at).toISOString()}
  host.mutate(current=>{
    current.progress=Object.assign({},current.progress||{})
    const previous=current.progress[state.pieceId]||{}
    const sameVersion=previous.schemaVersion===PROGRESS_SCHEMA_VERSION&&(!previous.audioKey||previous.audioKey===entry.audioKey)&&(!previous.contentVersion||previous.contentVersion===entry.contentVersion)&&(!previous.duration||Math.abs(Number(previous.duration)-entry.duration)<=.5)
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
    return current
  })
}
function clearAnchor(){anchor=null}
function beginAnchor(position){if(state.status==='playing')anchor={sessionId:state.sessionId,pieceId:state.pieceId,source:state.source,position:Number(position)||0,at:now(),rate:state.rate,continuous:0}}
function sample(position,forcePersist=false){
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
  if(!context||!state.pieceId)return
  const duration=Number.isFinite(context.duration)&&context.duration>0?context.duration:state.duration
  if(duration!==state.duration)state=Object.assign({},state,{duration})
  if(pendingSeek!==null&&duration>0){applyPendingSeek();notify();return}
  sample(Number(context.currentTime)||0,false)
}
function onPlay(){requestedPauseReason=null;if(state.pieceId){state=Object.assign({},state,{status:'playing',pauseReason:null,error:null});if(pendingSeek===null)beginAnchor(context&&context.currentTime);notify()}}
function onPause(){if(state.pieceId&&state.status!=='ended'&&state.status!=='error'){if(context)sample(context.currentTime,true);const pauseReason=requestedPauseReason||'system';requestedPauseReason=null;clearAnchor();update({status:'paused',pauseReason})}}
function onStop(){if(state.pieceId){if(context)sample(context.currentTime,true);requestedPauseReason=null;clearAnchor();update({status:'paused',pauseReason:'system_stop'})}}
function onEnded(){
  if(!state.pieceId)return
  const duration=Number.isFinite(context&&context.duration)&&context.duration>0?context.duration:state.duration
  sample(duration,false)
  const completed=state.completed||(state.coverage>=COMPLETION_COVERAGE&&tailCovered(state.listenedRanges,duration))
  clearAnchor();state=Object.assign({},state,{position:duration,duration,completed,status:state.loop?'playing':'ended',pauseReason:null});persist(true);notify()
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
function onError(error){if(context&&state.pieceId)sample(context.currentTime,true);clearAnchor();update({status:'error',error:audioErrorMessage(error)})}
function onSeeking(){if(context&&state.pieceId)sample(context.currentTime,true);clearAnchor()}
function onSeeked(){if(!context||!state.pieceId)return;const position=Number(context.currentTime)||0;pendingSeek=null;state=Object.assign({},state,{position});persist(true);if(state.status==='playing')beginAnchor(position);notify()}
function onWaiting(){waitingWasPlaying=state.status==='playing';if(context&&state.pieceId)sample(context.currentTime,true);clearAnchor();if(waitingWasPlaying)update({status:'loading'})}
function onCanplay(){if(!state.pieceId)return;if(pendingSeek!==null)applyPendingSeek();if(waitingWasPlaying){waitingWasPlaying=false;state=Object.assign({},state,{status:'playing'});beginAnchor(context&&context.currentTime)}notify()}

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
  sessionSequence++;anchor=null;pendingSeek=null;pendingListenSeconds=0;lastPersistAt=now()
  state={sessionId:sessionSequence,workId:book.workId||book.id,pieceId:pieceId(book),source,book:Object.assign({},book),contentVersion:book.contentVersion||null,position:restored.position,checkpointPosition:restored.checkpointPosition,duration:Number(book.duration)||0,rate:state.rate||1,status:status||'paused',pauseReason:status==='paused'?'selection':null,loop:false,completed:restored.completed,listenedRanges:restored.listenedRanges,coverage:coverageFor(restored.listenedRanges,Number(book.duration)||0),error:null}
  notify();return source
}
function selectTrack(book){const source=sourceFor(book);if(!source)return false;if(state.pieceId===pieceId(book)&&state.source===source)return true;if(context&&state.pieceId){sample(context.currentTime,true);if(state.status==='playing')context.pause()}newSession(book,'paused');return true}
function playTrack(book){
  const source=sourceFor(book);if(!source)return false
  const ctx=ensureContext(),same=state.pieceId===pieceId(book)&&state.source===source
  if(!same)newSession(book,'loading');else state=Object.assign({},state,{book:Object.assign({},book),duration:Number(state.duration)||Number(book.duration)||0,error:null})
  metadata(book,ctx);ctx.playbackRate=state.rate
  if(state.status==='ended'){const target=state.completed?0:state.checkpointPosition;state=Object.assign({},state,{position:target,status:'paused'});pendingSeek=target}
  else if(state.position>0)pendingSeek=state.position
  if('startTime' in ctx&&pendingSeek!==null)ctx.startTime=pendingSeek
  if(ctx.src===source){if(pendingSeek!==null)applyPendingSeek();ctx.play();update({status:'playing',pauseReason:null})}
  else{
    update({status:'loading',pauseReason:null})
    ctx.src=source
    // BackgroundAudioManager does not consistently autoplay a newly assigned
    // source on iOS. Always express the user's play intent explicitly.
    ctx.play()
  }
  return true
}
function pause(reason='user'){if(!state.pieceId)return;if(context)sample(context.currentTime,true);requestedPauseReason=reason;clearAnchor();state=Object.assign({},state,{status:'paused',pauseReason:reason});if(context)context.pause();notify()}
function resume(){if(!state.pieceId||!state.source)return false;return playTrack(state.book)}
function seek(seconds){
  if(!state.pieceId)return
  if(context)sample(context.currentTime,true)
  const position=clamp(seconds,0,state.duration||Number.MAX_SAFE_INTEGER)
  clearAnchor();pendingSeek=null;state=Object.assign({},state,{position})
  if(context)context.seek(position)
  persist(true);if(state.status==='playing')beginAnchor(position);notify()
}
function setRate(value){const rate=Number(value)||1;if(context&&state.pieceId)sample(context.currentTime,true);state=Object.assign({},state,{rate});if(context)context.playbackRate=rate;if(state.status==='playing')beginAnchor(context&&context.currentTime);notify()}
function setLoop(loop){update({loop:!!loop})}
function subscribe(subscriber){subscribers.add(subscriber);subscriber(snapshot());return()=>subscribers.delete(subscriber)}
function resetForTests(){context=null;backgroundBound=false;sessionSequence=0;anchor=null;pendingSeek=null;pendingListenSeconds=0;lastPersistAt=0;requestedPauseReason=null;waitingWasPlaying=false;now=()=>Date.now();subscribers.clear();state=initialState()}
function setNowForTests(fn){now=fn}

module.exports={snapshot,subscribe,selectTrack,playTrack,play:playTrack,pause,resume,seek,setRate,rate:setRate,setLoop,_resetForTests:resetForTests,_setNowForTests:setNowForTests,_constants:{PROGRESS_SCHEMA_VERSION,COMPLETION_COVERAGE,COMPLETION_TAIL_SECONDS,CHECKPOINT_TRUST_SECONDS}}
