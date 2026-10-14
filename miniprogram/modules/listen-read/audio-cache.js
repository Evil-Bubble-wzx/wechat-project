const {sha256}=require('../sync/local-import'),{createSha256}=require('./sha256-stream')
const INDEX_KEY='tingyue.audio-cache.v1',OWNER_KEY='tingyue.offline-owner.v1',DEFAULT_LIMIT=1024*1024*1024
const clone=v=>JSON.parse(JSON.stringify(v)),fault=code=>Object.assign(Error(code),{code,kind:'download'})
function createAudioCache(runtime){
 let environment='unknown';try{const value=runtime?.getAccountInfoSync?.().miniProgram?.envVersion;if(['develop','trial','release'].includes(value))environment=value}catch(_){}
 const suffix=environment==='develop'?'':':'+environment,indexKey=INDEX_KEY+suffix,ownerKey=OWNER_KEY+suffix
 const enabled=!!(runtime?.getFileSystemManager&&runtime?.downloadFile&&runtime?.env?.USER_DATA_PATH),fs=enabled?runtime.getFileSystemManager():null,root=enabled?runtime.env.USER_DATA_PATH+'/tingyue-audio-v1'+(environment==='develop'?'':'-'+environment):''
 let queue=Promise.resolve(),activePath=null;const pending=new Map(),verifiedFiles=new Map(),observers=new Map()
 const call=(method,input)=>new Promise((resolve,reject)=>fs[method]({...input,success:resolve,fail:reject}))
 function index(){let value;try{value=runtime.getStorageSync(indexKey)}catch(_){}const valid=value?.schemaVersion===1?value:{schemaVersion:1,limit:DEFAULT_LIMIT,entries:{}};return {...valid,entries:{...valid.entries},limit:Number.isSafeInteger(valid.limit)&&valid.limit>0?valid.limit:DEFAULT_LIMIT}}
 function save(value){runtime.setStorageSync(indexKey,value)}
 function validPath(p){return typeof p==='string'&&p.startsWith(root+'/')&&/^[a-f0-9]{64}\.(mp3|m4a|wav|ogg|json)$/.test(p.slice(root.length+1))}
 async function removeEntry(idx,key){const entry=idx.entries[key];if(!entry)return;if(entry.path===activePath)throw fault('AUDIO_IN_USE');for(const p of [entry.path,entry.packagePath])if(validPath(p))await call('unlink',{filePath:p}).catch(error=>{if(!/ENOENT|no such|not exist/i.test(String(error?.errMsg||error?.message||error?.code||'')))throw fault('CACHE_DELETE_FAILED')});verifiedFiles.delete(entry.path);delete idx.entries[key];save(idx)}
 async function room(idx,bytes,exclude){const used=()=>Object.values(idx.entries).reduce((n,e)=>n+e.sizeBytes+e.packageBytes,0);for(const [key,e]of Object.entries(idx.entries).filter(([k,e])=>k!==exclude&&!e.pinned&&e.path!==activePath).sort((a,b)=>a[1].lastUsed-b[1].lastUsed)){if(used()+bytes<=idx.limit)break;await removeEntry(idx,key)}if(used()+bytes>idx.limit)throw fault('CACHE_LIMIT_REACHED')}
 async function hashFile(filePath,size){const {fd}=await call('open',{filePath,flag:'r'});const hash=createSha256();let pos=0;try{while(pos<size){const length=Math.min(256*1024,size-pos),arrayBuffer=new ArrayBuffer(length),result=await call('read',{fd,arrayBuffer,offset:0,length,position:pos});if(!result.bytesRead)throw fault('AUDIO_FILE_TRUNCATED');hash.update(new Uint8Array(result.arrayBuffer||arrayBuffer,0,result.bytesRead));pos+=result.bytesRead;await new Promise(r=>setTimeout(r,0))}return hash.digest()}finally{await call('close',{fd}).catch(()=>{})}}
 async function permission(size,{confirmed=false}={}){if(confirmed)return;const type=await new Promise(resolve=>runtime.getNetworkType?runtime.getNetworkType({success:r=>resolve(r.networkType),fail:()=>resolve('unknown')}):resolve('unknown'));if(type==='none')throw fault('OFFLINE_NOT_DOWNLOADED');if(type==='wifi')return;const accepted=await new Promise(resolve=>runtime.showModal({title:'下载音频',content:'本次约 '+(size/1024/1024).toFixed(1)+' MB，将使用移动网络。是否继续？',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));if(!accepted)throw fault('DOWNLOAD_CANCELLED')}
 function keyFor(owner,pieceId,version,digest){return sha256(JSON.stringify([owner,pieceId,version,digest]))}
 const current=options=>!options.current||options.current()
 async function get(owner,pieceId,version){if(!enabled||!owner)return null;const idx=index(),candidates=Object.entries(idx.entries).filter(([,e])=>e.owner===owner&&e.pieceId===pieceId&&(!version||e.contentVersion===version)&&!e.revoked&&e.complete!==false).sort((a,b)=>b[1].contentVersion-a[1].contentVersion);for(const [key,e]of candidates){if(!validPath(e.path)||!validPath(e.packagePath))continue;try{const stat=await call('stat',{path:e.path});if(stat.stats.size!==e.audioBytes)throw fault('CACHE_FILE_MISSING');if(verifiedFiles.get(e.path)!==e.audioSha256){if(await hashFile(e.path,e.audioBytes)!==e.audioSha256)throw fault('AUDIO_CHECKSUM_MISMATCH');verifiedFiles.set(e.path,e.audioSha256)}const {data}=await call('readFile',{filePath:e.packagePath,encoding:'utf8'});if(sha256(data)!==e.packageSha256)throw fault('CACHE_PACKAGE_CHANGED');const pack=JSON.parse(data);if(pack.owner!==owner||pack.book.pieceId!==pieceId||pack.book.contentVersion!==e.contentVersion)throw fault('CACHE_IDENTITY_CHANGED');const latest=index();if(!latest.entries[key]||latest.entries[key].revoked)continue;latest.entries[key].lastUsed=Date.now();save(latest);return {...clone(pack),path:e.path,audioSha256:e.audioSha256,pinned:e.pinned}}catch(_){await removeEntry(index(),key).catch(()=>{})}}return null}
 async function ensure(owner,book,bundle,manifest,options={}){
  if(!enabled)return null;if(!owner||book.access!=='free'||book.pieceId!==bundle.pieceId||book.contentVersion!==bundle.contentVersion)throw fault('OFFLINE_CONTENT_NOT_ALLOWED')
  const audio=manifest.assets.find(a=>a.type==='audio');if(!audio||!/^[a-f0-9]{64}$/.test(audio.sha256)||!Number.isSafeInteger(audio.sizeBytes)||audio.sizeBytes<=0||!audio.mimeType.startsWith('audio/'))throw fault('AUDIO_ASSET_INVALID')
  const key=keyFor(owner,bundle.pieceId,bundle.contentVersion,audio.sha256)
  if(pending.has(key)){observers.get(key)?.push(options);const result=await pending.get(key);if(options.pinned&&current(options)&&result)pin(owner,key);return result}
  observers.set(key,[options]);const needed=()=>observers.get(key)?.some(current);const progress=value=>{for(const observer of observers.get(key)||[])if(current(observer))observer.onProgress?.(value)}
  const work=async()=>{
   if(!needed())throw fault('DOWNLOAD_CANCELLED')
   const existing=await get(owner,bundle.pieceId,bundle.contentVersion);if(existing){if(existing.audioSha256!==audio.sha256)throw fault('CACHE_VERSION_CHANGED');if(options.pinned)pin(owner,key);return existing}
   const interrupted=index();if(interrupted.entries[key])await removeEntry(interrupted,key);const cleanBook={};for(const field of ['id','workId','title','chapterTitle','author','narrator','words','duration','pieceId','chapterId','contentVersion','quizVersion','access'])if(book[field]!==undefined)cleanBook[field]=book[field]
   Object.assign(cleanBook,{remote:true,hasQuiz:bundle.quiz.questions.length>0,cover:'/assets/icon-book.png'})
   const cleanBundle=clone(bundle);delete cleanBundle.audioUrl;delete cleanBundle.coverUrl
   const pack=JSON.stringify({schemaVersion:1,owner,book:cleanBook,bundle:cleanBundle}),packageBytes=new TextLength(pack).bytes,idx=index()
   await permission(audio.sizeBytes,options);await room(idx,audio.sizeBytes+packageBytes,key)
   if(!current(options))throw fault('DOWNLOAD_CANCELLED')
   await call('mkdir',{dirPath:root,recursive:true}).catch(()=>{})
   let task;const downloaded=await new Promise((resolve,reject)=>{task=runtime.downloadFile({url:audio.url,timeout:120000,success:r=>r.statusCode===200?resolve(r):reject(fault('AUDIO_DOWNLOAD_FAILED')),fail:()=>reject(fault(needed()?'AUDIO_DOWNLOAD_FAILED':'DOWNLOAD_CANCELLED'))});task?.onProgressUpdate?.(r=>{if(!needed()){task.abort();return}progress({stage:'download',percent:r.progress,bytes:r.totalBytesWritten,total:audio.sizeBytes})})})
   const temp=downloaded.tempFilePath;let path,packagePath
   try{
    if(!current(options))throw fault('DOWNLOAD_CANCELLED');const stat=await call('stat',{path:temp});if(stat.stats.size!==audio.sizeBytes)throw fault('AUDIO_SIZE_MISMATCH')
    options.onProgress?.({stage:'verify',percent:100,bytes:audio.sizeBytes,total:audio.sizeBytes});if(await hashFile(temp,audio.sizeBytes)!==audio.sha256)throw fault('AUDIO_CHECKSUM_MISMATCH')
    if(!current(options))throw fault('DOWNLOAD_CANCELLED')
    const extension=audio.mimeType.includes('wav')?'wav':audio.mimeType.includes('ogg')?'ogg':audio.mimeType.includes('mp4')?'m4a':'mp3';path=root+'/'+key+'.'+extension;packagePath=root+'/'+key+'.json'
    // Persist the owned paths before installation so a process restart can clean
    // an interrupted install without mistaking it for an available chapter.
    const staging=index();staging.entries[key]={owner,workId:book.workId||book.id,pieceId:bundle.pieceId,contentVersion:bundle.contentVersion,quizVersion:bundle.quizVersion,title:book.title,chapterTitle:book.chapterTitle||book.title,durationMs:Math.round(book.duration*1000),path,packagePath,packageSha256:sha256(pack),audioSha256:audio.sha256,sizeBytes:audio.sizeBytes,audioBytes:audio.sizeBytes,packageBytes,pinned:!!observers.get(key)?.some(o=>o.pinned&&current(o)),lastUsed:Date.now(),revoked:false,complete:false};save(staging)
    await call('saveFile',{tempFilePath:temp,filePath:path});await call('writeFile',{filePath:packagePath,data:pack,encoding:'utf8'})
    if(!current(options))throw fault('DOWNLOAD_CANCELLED')
    idx.entries[key]={owner,workId:book.workId||book.id,pieceId:bundle.pieceId,contentVersion:bundle.contentVersion,quizVersion:bundle.quizVersion,title:book.title,chapterTitle:book.chapterTitle||book.title,durationMs:Math.round(book.duration*1000),path,packagePath,packageSha256:sha256(pack),audioSha256:audio.sha256,sizeBytes:audio.sizeBytes,audioBytes:audio.sizeBytes,packageBytes,pinned:!!options.pinned,lastUsed:Date.now(),revoked:false};const latest=index();latest.entries[key]=idx.entries[key];save(latest);verifiedFiles.set(path,audio.sha256)
    options.onProgress?.({stage:'ready',percent:100,bytes:audio.sizeBytes,total:audio.sizeBytes});return {...JSON.parse(pack),path,audioSha256:audio.sha256,pinned:!!options.pinned}
   }catch(error){if(index().entries[key]?.complete===false)await removeEntry(index(),key).catch(()=>{});else for(const p of [path,packagePath])if(p&&validPath(p))await call('unlink',{filePath:p}).catch(()=>{});throw error}finally{await call('unlink',{filePath:temp}).catch(()=>{})}
  }
  const promise=queue.then(work);queue=promise.catch(()=>{});pending.set(key,promise)
  try{return await promise}finally{pending.delete(key);observers.delete(key)}
 }
 function pin(owner,key){const idx=index(),e=idx.entries[key];if(e?.owner===owner){e.pinned=true;save(idx)}}
 function summary(owner){if(!enabled)return {enabled:false,limit:DEFAULT_LIMIT,used:0,items:[]};const idx=index();return {enabled:true,limit:idx.limit,used:Object.values(idx.entries).reduce((n,e)=>n+e.sizeBytes+e.packageBytes,0),items:Object.entries(idx.entries).filter(([,e])=>e.owner===owner).map(([key,e])=>({key,workId:e.workId,pieceId:e.pieceId,contentVersion:e.contentVersion,quizVersion:e.quizVersion,durationMs:e.durationMs,title:e.title,chapterTitle:e.chapterTitle,bytes:e.sizeBytes+e.packageBytes,pinned:e.pinned,complete:e.complete!==false,revoked:!!e.revoked,lastUsed:e.lastUsed}))}}
 async function remove(owner,key){const action=async()=>{const idx=index();if(idx.entries[key]?.owner===owner)await removeEntry(idx,key)};const p=queue.then(action);queue=p.catch(()=>{});return p}
 async function setLimit(bytes){if(!Number.isSafeInteger(bytes)||bytes<64*1024*1024||bytes>2*1024*1024*1024)throw fault('CACHE_LIMIT_INVALID');const action=async()=>{const idx=index();idx.limit=bytes;const protectedBytes=Object.values(idx.entries).filter(e=>e.pinned||e.path===activePath).reduce((n,e)=>n+e.sizeBytes+e.packageBytes,0);if(protectedBytes>bytes)throw fault('PINNED_CACHE_TOO_LARGE');await room(idx,0);save(idx)};const p=queue.then(action);queue=p.catch(()=>{});return p}
 function rememberOwner(owner){if(enabled)try{runtime.setStorageSync(ownerKey,owner||'')}catch(_){}}
 function rememberedOwner(){if(!enabled)return null;let owner;try{owner=runtime.getStorageSync(ownerKey)}catch(_){return null}return typeof owner==='string'&&summary(owner).items.some(e=>!e.revoked&&e.complete)?owner:null}
 function revoke(owner,pieceId){if(!enabled)return;const idx=index();for(const e of Object.values(idx.entries))if(e.owner===owner&&e.pieceId===pieceId)e.revoked=true;save(idx)}
 return {enabled,ensure,get,summary,remove,setLimit,permission,rememberOwner,rememberedOwner,revoke,setActivePath:path=>{activePath=path||null}}
}
// Count UTF-8 package bytes without requiring TextEncoder in the mini program.
function TextLength(s){this.bytes=encodeURIComponent(s).replace(/%[A-F\d]{2}/gi,'x').length}
let singleton,runtimeRef
function active(){const runtime=typeof wx==='undefined'?null:wx;if(!singleton||runtime!==runtimeRef){runtimeRef=runtime;singleton=createAudioCache(runtime)}return singleton}
module.exports={createAudioCache,DEFAULT_LIMIT,enabled:()=>active().enabled,ensure:(...a)=>active().ensure(...a),get:(...a)=>active().get(...a),summary:(...a)=>active().summary(...a),remove:(...a)=>active().remove(...a),setLimit:(...a)=>active().setLimit(...a),permission:(...a)=>active().permission(...a),rememberOwner:(...a)=>active().rememberOwner(...a),rememberedOwner:()=>active().rememberedOwner(),revoke:(...a)=>active().revoke(...a),setActivePath:(...a)=>active().setActivePath(...a)}
