window.previewDepth = 0
let audioManager
function createAudioManager() {
  const audio = new Audio()
  audio.preload = 'metadata'
  let source = '', startTime = 0
  const listeners = { time:new Set(), end:new Set(), error:new Set(), play:new Set(), pause:new Set(), stop:new Set(), seeking:new Set(), seeked:new Set(), canplay:new Set(), waiting:new Set() }
  const emit = type => listeners[type].forEach(fn=>fn())
  const play = () => { audio.play().catch(()=>emit('error')) }
  audio.addEventListener('timeupdate',()=>emit('time'))
  audio.addEventListener('loadedmetadata',()=>{if(startTime>0){audio.currentTime=startTime;startTime=0}emit('time')})
  audio.addEventListener('ended',()=>emit('end'))
  audio.addEventListener('error',()=>emit('error'))
  audio.addEventListener('play',()=>emit('play'))
  audio.addEventListener('pause',()=>{if(!audio.ended)emit('pause')})
  audio.addEventListener('seeking',()=>emit('seeking'))
  audio.addEventListener('seeked',()=>emit('seeked'))
  audio.addEventListener('canplay',()=>emit('canplay'))
  audio.addEventListener('waiting',()=>emit('waiting'))
  // Exposed only in the development preview for reproducible playback tests.
  window.previewAudio = audio
  return {
    get src(){ return source }, set src(value){source=value; audio.src=value; play()},
    get currentTime(){return audio.currentTime},get duration(){return audio.duration},
    get playbackRate(){return audio.playbackRate},set playbackRate(value){audio.playbackRate=value},
    get startTime(){return startTime},set startTime(value){startTime=Math.max(0,Number(value)||0)},
    play,pause(){audio.pause()},stop(){audio.pause();audio.currentTime=0;emit('stop')},destroy(){audio.pause();audio.src=''},seek(seconds){if(audio.readyState>0)audio.currentTime=seconds},
    onTimeUpdate(fn){listeners.time.add(fn)},offTimeUpdate(fn){listeners.time.delete(fn)},
    onEnded(fn){listeners.end.add(fn)},offEnded(fn){listeners.end.delete(fn)},
    onError(fn){listeners.error.add(fn)},offError(fn){listeners.error.delete(fn)},
    onPlay(fn){listeners.play.add(fn)},offPlay(fn){listeners.play.delete(fn)},
    onPause(fn){listeners.pause.add(fn)},offPause(fn){listeners.pause.delete(fn)},
    onStop(fn){listeners.stop.add(fn)},offStop(fn){listeners.stop.delete(fn)},
    onSeeking(fn){listeners.seeking.add(fn)},offSeeking(fn){listeners.seeking.delete(fn)},
    onSeeked(fn){listeners.seeked.add(fn)},offSeeked(fn){listeners.seeked.delete(fn)},
    onCanplay(fn){listeners.canplay.add(fn)},offCanplay(fn){listeners.canplay.delete(fn)},
    onWaiting(fn){listeners.waiting.add(fn)},offWaiting(fn){listeners.waiting.delete(fn)}
  }
}
window.wx = {
  isBrowserPreview:true,
  getStorageSync(key) { try{return JSON.parse(localStorage.getItem(key))}catch{return null} },
  setStorageSync(key,value) {localStorage.setItem(key,JSON.stringify(value))},
  showToast({title}) {const el=document.getElementById('toast');el.textContent=title;el.style.display='block';clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>el.style.display='none',2600)},
  getWindowInfo() {return {statusBarHeight:0}},
  switchTab({url}) {window.goUrl(url)}, navigateTo({url}) {window.goUrl(url)},
  navigateBack() {if(window.previewDepth>0){window.previewDepth--;history.back()}else location.hash='home'},
  getBackgroundAudioManager(){if(!audioManager)audioManager=createAudioManager();return audioManager},
  createInnerAudioContext(){return createAudioManager()}
}
window.getCurrentPages=()=>window.previewDepth>0?[{},{}]:[{}]
window.goUrl=url=>{const match=url.match(/\/pages\/([^/]+)\/index(.*)/);if(match){window.previewDepth++;location.hash=match[1]+match[2]}}
