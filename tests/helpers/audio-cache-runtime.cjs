const crypto=require('node:crypto');const {createAudioCache}=require('../../miniprogram/modules/listen-read/audio-cache');const clone=x=>JSON.parse(JSON.stringify(x));
function harness(){
 const storage=new Map(),files=new Map(),fds=new Map();let serial=0,downloads=0,network='wifi',confirm=true,modalCount=0,diskFull=false
 const result=(options,fn)=>{try{options.success(fn())}catch(e){options.fail(e)}}
 const fs={mkdir:o=>o.success({}),unlink:o=>result(o,()=>{files.delete(o.filePath);return {}}),stat:o=>result(o,()=>{if(!files.has(o.path))throw Error('missing');return {stats:{size:files.get(o.path).length}}}),
  readFile:o=>result(o,()=>{const b=files.get(o.filePath);if(!b)throw Error('missing');return {data:o.encoding?b.toString():b.buffer.slice(b.byteOffset,b.byteOffset+b.length)}}),
  writeFile:o=>result(o,()=>{if(diskFull)throw Error('disk full');files.set(o.filePath,Buffer.from(o.data));return {}}),
  saveFile:o=>result(o,()=>{if(diskFull)throw Error('disk full');files.set(o.filePath,files.get(o.tempFilePath));files.delete(o.tempFilePath);return {savedFilePath:o.filePath}}),
  open:o=>result(o,()=>{const fd=String(++serial);fds.set(fd,o.filePath);return {fd}}),close:o=>{fds.delete(o.fd);o.success({})},
  read:o=>result(o,()=>{const b=files.get(fds.get(o.fd)),n=Math.min(o.length,b.length-o.position);new Uint8Array(o.arrayBuffer).set(b.subarray(o.position,o.position+n));return {arrayBuffer:o.arrayBuffer,bytesRead:n}})}
 const resources=new Map(),runtime={env:{USER_DATA_PATH:'wxfile://usr'},getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getFileSystemManager:()=>fs,getStorageSync:k=>storage.has(k)?clone(storage.get(k)):'',setStorageSync:(k,v)=>storage.set(k,clone(v)),getNetworkType:o=>o.success({networkType:network}),showModal:o=>{modalCount++;o.success({confirm})},
  downloadFile:o=>{downloads++;const temp='wxfile://tmp/'+(++serial);const bytes=resources.get(o.url);let listener,aborted=false;setImmediate(()=>{if(aborted)return;files.set(temp,bytes);listener?.({progress:100,totalBytesWritten:bytes.length});if(!aborted)o.success({statusCode:200,tempFilePath:temp})});return {onProgressUpdate:fn=>{listener=fn},abort:()=>{aborted=true;o.fail(Error('aborted'))}}}}
 const cache=createAudioCache(runtime)
 const fixture=(pieceId='piece-1',version=1)=>{const bytes=Buffer.from('Audio file: '+pieceId),sha256=crypto.createHash('sha256').update(bytes).digest('hex'),url='https://assets.test/'+pieceId+'/'+version;resources.set(url,bytes);const book={id:'work',workId:'work',pieceId,chapterId:pieceId,title:'Story',chapterTitle:pieceId,access:'free',contentVersion:version,quizVersion:1,duration:10},bundle={workId:'work',pieceId,contentVersion:version,quizVersion:1,duration:10,cues:[],vocabulary:{},quiz:{schemaVersion:1,workId:'work',pieceId,contentVersion:version,quizVersion:1,questions:[{id:'q',q:'Which one?',options:['a','b'],answer:0}]},metadata:{},audioUrl:url,coverUrl:'https://assets.test/cover'},manifest={assets:[{type:'audio',url,mimeType:'audio/mpeg',sizeBytes:bytes.length,sha256}]};return {book,bundle,manifest,bytes}}
 return {cache,runtime,storage,files,fixture,downloads:()=>downloads,modals:()=>modalCount,setNetwork:x=>network=x,setConfirm:x=>confirm=x,setDiskFull:x=>diskFull=x,resources}
}

module.exports={harness};
