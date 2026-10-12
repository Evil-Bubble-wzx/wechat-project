const {validateManifest}=require('../catalog/remote-resources')
const fault=code=>Object.assign(new Error(code),{kind:'content',code,retryable:false})
const pieceId=book=>book.chapterId||book.pieceId||book.id
function lease(book){
  const asset=book?.remoteManifest?.assets?.find(item=>item.type==='audio')
  return asset&&asset.url===(book.localAudio||book.audioUrl)?asset:null
}
function expired(book,now=Date.now()){
  const asset=lease(book)
  return !!(asset&&Number.isFinite(Date.parse(asset.expiresAt))&&Date.parse(asset.expiresAt)<=now+15000)
}
function createAudioLeaseResolver(options={}){
  const api=options.api||require('../../services/api'),host=options.host||require('../../services/host')
  return async book=>{
    const userId=api.currentUser()?.userId
    const current=()=>!!userId&&api.isAuthenticated()&&api.currentUser()?.userId===userId&&host.accountScope()===userId&&book.audioAccountScope===userId
    if(!current())throw fault('AUDIO_ACCOUNT_CHANGED')
    const expected={workId:book.workId||book.id,pieceId:pieceId(book),contentVersion:book.contentVersion}
    const original=book.remoteManifest,oldAssets=validateManifest(original,expected),oldAudio=oldAssets.get('audio')
    if(!lease(book)||!oldAudio.mimeType.startsWith('audio/')||!Number.isSafeInteger(original.durationMs)||original.durationMs<=0)throw fault('AUDIO_LEASE_INVALID')
    const manifest=await api.getManifest(expected.pieceId,expected.contentVersion)
    if(!current())throw fault('AUDIO_ACCOUNT_CHANGED')
    const assets=validateManifest(manifest,expected),audio=assets.get('audio')
    if(manifest.manifestSha256!==original.manifestSha256||manifest.quizVersion!==original.quizVersion||
      manifest.durationMs!==original.durationMs||audio.sha256!==oldAudio.sha256||audio.sizeBytes!==oldAudio.sizeBytes||
      audio.mimeType!==oldAudio.mimeType||(oldAudio.assetId&&audio.assetId!==oldAudio.assetId)||
      !Number.isFinite(Date.parse(audio.expiresAt))||
      (Number.isFinite(Date.parse(oldAudio.expiresAt))&&Date.parse(audio.expiresAt)<Date.parse(oldAudio.expiresAt)))throw fault('AUDIO_LEASE_IDENTITY_CHANGED')
    return Object.assign({},book,{localAudio:audio.url,cover:assets.get('cover').url,remoteManifest:manifest,audioAccountScope:userId})
  }
}
let resolver
module.exports={lease,expired,createAudioLeaseResolver,renew:book=>(resolver||(resolver=createAudioLeaseResolver()))(book)}
