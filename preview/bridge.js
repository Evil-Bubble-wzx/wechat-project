window.previewDepth = 0
let audioManager
function createAudioManager() {
  const audio = new Audio()
  audio.preload = 'metadata'
  let source = ''
  const listeners = { time:new Set(), end:new Set(), error:new Set() }
  const emit = type => listeners[type].forEach(fn=>fn())
  const play = () => { audio.play().catch(()=>emit('error')) }
  audio.addEventListener('timeupdate',()=>emit('time'))
  audio.addEventListener('loadedmetadata',()=>emit('time'))
  audio.addEventListener('ended',()=>emit('end'))
  audio.addEventListener('error',()=>emit('error'))
  // Exposed only in the development preview for reproducible playback tests.
  window.previewAudio = audio
  return {
    get src(){ return source }, set src(value){source=value; audio.src=value; play()},
    get currentTime(){return audio.currentTime},get duration(){return audio.duration},
    get playbackRate(){return audio.playbackRate},set playbackRate(value){audio.playbackRate=value},
    play,pause(){audio.pause()},stop(){audio.pause();audio.currentTime=0},destroy(){audio.pause();audio.src=''},seek(seconds){if(audio.readyState>0)audio.currentTime=seconds},
    onTimeUpdate(fn){listeners.time.add(fn)},offTimeUpdate(fn){listeners.time.delete(fn)},
    onEnded(fn){listeners.end.add(fn)},offEnded(fn){listeners.end.delete(fn)},
    onError(fn){listeners.error.add(fn)},offError(fn){listeners.error.delete(fn)}
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
