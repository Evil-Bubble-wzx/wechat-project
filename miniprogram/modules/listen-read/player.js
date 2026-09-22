// The singleton BackgroundAudioManager and this module form the single source
// of truth for the in-process playback session. Pages subscribe to snapshots;
// they never own audio callbacks or resume playback from onShow.
const host = require('../../services/host')

let context
let backgroundBound = false
let sessionSequence = 0
let lastTick = null
let requestedPauseReason = null
const subscribers = new Set()
const initialState = () => ({ sessionId:0, workId:null, pieceId:null, source:'', book:null, position:0, duration:0, rate:1, status:'idle', pauseReason:null, loop:false, error:null })
let state = initialState()

const pieceId = book => book && (book.chapterId || book.pieceId || book.id)
const sourceFor = book => book && (book.localAudio || (wx.isBrowserPreview && book.previewAudioUrl ? book.previewAudioUrl : book.audioUrl))
const snapshot = () => Object.assign({}, state, { book:state.book ? Object.assign({}, state.book) : null })
function notify() { const value=snapshot();for(const subscriber of [...subscribers])subscriber(value) }
function update(patch) { state=Object.assign({},state,patch);notify();return snapshot() }
const pad2 = n => String(n).padStart(2,'0')
const dayKey = (date = new Date()) => date.getFullYear()+'-'+pad2(date.getMonth()+1)+'-'+pad2(date.getDate())

function persistProgress(position, duration, completed, delta) {
  if (!state.pieceId) return
  host.mutate(current => {
    current.progress = Object.assign({}, current.progress || {})
    const previous = current.progress[state.pieceId] || {}
    current.progress[state.pieceId] = { seconds:position, completed:!!(completed || previous.completed) }
    if (delta > 0 && delta <= 2) {
      const key = dayKey()+':'+state.pieceId
      current.listenDaily = Object.assign({}, current.listenDaily || {})
      const used = Number(current.listenDaily[key]) || 0
      const add = Math.min(delta, Math.max(0, (duration || 0) * 1.2 - used))
      if (add > 0) {
        current.listeningSec = (Number(current.listeningSec) || 0) + add
        current.listenDaily[key] = used + add
      }
    }
    return current
  })
}

function onTimeUpdate() {
  if (!context || !state.pieceId) return
  const position = Number(context.currentTime) || 0
  const duration = Number.isFinite(context.duration) && context.duration > 0 ? context.duration : state.duration
  const delta = state.status === 'playing' && lastTick && lastTick.pieceId === state.pieceId ? position-lastTick.position : 0
  lastTick = { pieceId:state.pieceId, position }
  persistProgress(position,duration,false,delta)
  update({ position,duration,error:null })
}
function onPlay() { requestedPauseReason=null;if(state.pieceId){lastTick=null;update({status:'playing',pauseReason:null,error:null})} }
function onPause() { if(state.pieceId && state.status!=='ended' && state.status!=='error'){const pauseReason=requestedPauseReason||'system';requestedPauseReason=null;lastTick=null;update({status:'paused',pauseReason})} }
function onStop() { requestedPauseReason=null;if(state.pieceId){lastTick=null;update({status:'paused',pauseReason:'system_stop'})} }
function onEnded() {
  if (!state.pieceId) return
  const duration = Number.isFinite(context && context.duration) && context.duration > 0 ? context.duration : state.duration
  persistProgress(duration,duration,true,0)
  lastTick=null
  if (state.loop) {
    update({position:0,duration,status:'playing',pauseReason:null})
    if(context){context.seek(0);context.play()}
  } else update({position:duration,duration,status:'ended',pauseReason:null})
}
function onError(error) { lastTick=null;update({status:'error',error:error && (error.errMsg || error.message) || 'audio_error'}) }

function bindBackground(ctx) {
  if (backgroundBound) return
  ctx.onTimeUpdate(onTimeUpdate)
  ctx.onEnded(onEnded)
  ctx.onError(onError)
  if (typeof ctx.onPlay === 'function') ctx.onPlay(onPlay)
  if (typeof ctx.onPause === 'function') ctx.onPause(onPause)
  if (typeof ctx.onStop === 'function') ctx.onStop(onStop)
  backgroundBound = true
}
function ensureContext() {
  if (!context) { context=wx.getBackgroundAudioManager();bindBackground(context) }
  return context
}
function metadata(book, ctx) {
  ctx.title=book.chapterTitle || book.title
  ctx.singer=book.narrator || book.author
  if(book.coverUrl || book.cover)ctx.coverImgUrl=book.coverUrl || book.cover
}
function newSession(book, status) {
  const source=sourceFor(book)
  sessionSequence++
  lastTick=null
  state={sessionId:sessionSequence,workId:book.workId||book.id,pieceId:pieceId(book),source,book:Object.assign({},book),position:0,duration:Number(book.duration)||0,rate:state.rate||1,status:status||'paused',pauseReason:status==='paused'?'selection':null,loop:false,error:null}
  notify()
  return source
}

function selectTrack(book) {
  const source=sourceFor(book)
  if (!source) return false
  if (state.pieceId===pieceId(book) && state.source===source) return true
  if (context && state.status==='playing') context.pause()
  newSession(book,'paused')
  return true
}
function playTrack(book) {
  const source=sourceFor(book)
  if (!source) return false
  const ctx=ensureContext()
  const same=state.pieceId===pieceId(book) && state.source===source
  if(!same)newSession(book,'loading')
  else state=Object.assign({},state,{book:Object.assign({},book),duration:Number(state.duration)||Number(book.duration)||0,error:null})
  metadata(book,ctx)
  ctx.playbackRate=state.rate
  if(state.status==='ended'){ctx.seek(0);state=Object.assign({},state,{position:0})}
  if(ctx.src===source){ctx.play();update({status:'playing',pauseReason:null})}
  else {update({status:'loading',pauseReason:null});ctx.src=source}
  return true
}
function pause(reason='user') {
  if(!state.pieceId)return
  lastTick=null
  requestedPauseReason=reason
  state=Object.assign({},state,{status:'paused',pauseReason:reason})
  if(context)context.pause()
  notify()
}
function resume() {
  if(!state.pieceId || !state.source)return false
  const ctx=ensureContext()
  metadata(state.book,ctx)
  ctx.playbackRate=state.rate
  if(state.status==='ended'){ctx.seek(0);state=Object.assign({},state,{position:0})}
  if(ctx.src!==state.source)ctx.src=state.source
  else ctx.play()
  update({status:'playing',pauseReason:null,error:null})
  return true
}
function seek(seconds) {
  if(!state.pieceId)return
  const position=Math.max(0,Math.min(Number(seconds)||0,state.duration||Number.MAX_SAFE_INTEGER))
  lastTick=null
  if(context)context.seek(position)
  persistProgress(position,state.duration,false,0)
  update({position})
}
function setRate(value) {
  const rate=Number(value)||1
  if(context)context.playbackRate=rate
  update({rate})
}
function setLoop(loop) { update({loop:!!loop}) }
function subscribe(subscriber) { subscribers.add(subscriber);subscriber(snapshot());return ()=>subscribers.delete(subscriber) }
function resetForTests() { context=null;backgroundBound=false;sessionSequence=0;lastTick=null;requestedPauseReason=null;subscribers.clear();state=initialState() }

module.exports={snapshot,subscribe,selectTrack,playTrack,play:playTrack,pause,resume,seek,setRate,rate:setRate,setLoop,_resetForTests:resetForTests}
