const {sha256,sha256Bytes}=require('../sync/local-import')
const fail=message=>Object.assign(new Error(message),{kind:'content',retryable:false})
const jsonTypes=['subtitles','vocabulary','quiz','metadata']
const verifiedCache=new Map()
let cacheScope=null
function clearCache(){verifiedCache.clear();cacheScope=null}
function decode(bytes){
  // decodeURIComponent validates UTF-8 without requiring TextDecoder in WeChat.
  try{return decodeURIComponent(Array.from(bytes,value=>'%'+value.toString(16).padStart(2,'0')).join('')).replace(/^\uFEFF/,'')}catch(_){throw fail('Resource is not valid UTF-8')}
}
function requestBytes(asset,runtime=typeof wx==='undefined'?null:wx){
  return new Promise((resolve,reject)=>{
    if(!runtime?.request)return reject(fail('Resource transport unavailable'))
    runtime.request({url:asset.url,method:'GET',responseType:'arraybuffer',dataType:'text',timeout:20000,
      success:response=>response.statusCode===200?resolve(response.data):reject(Object.assign(new Error('Resource request failed'),{kind:'network',retryable:response.statusCode>=500})),fail:reject})
  })
}
function validateManifest(manifest,expected){
  if(!manifest||manifest.workId!==expected.workId||manifest.pieceId!==expected.pieceId||manifest.contentVersion!==expected.contentVersion||!Number.isInteger(manifest.quizVersion)||manifest.quizVersion<1||!Array.isArray(manifest.assets))throw fail('Manifest identity mismatch')
  const assets=new Map()
  for(const asset of manifest.assets){
    if(assets.has(asset.type)||!['audio','cover','text',...jsonTypes].includes(asset.type)||typeof asset.url!=='string'||!/^https?:\/\//.test(asset.url)||typeof asset.mimeType!=='string'||!Number.isSafeInteger(asset.sizeBytes)||asset.sizeBytes<0||!/^[a-f0-9]{64}$/.test(asset.sha256))throw fail('Manifest asset is invalid')
    if(!/^https:\/\//.test(asset.url)&&!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(asset.url))throw fail('Insecure asset URL')
    assets.set(asset.type,asset)
  }
  if(assets.size!==7)throw fail('Complete version resources are required')
  const digest=sha256(JSON.stringify([...assets.values()].sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:0).map(asset=>({type:asset.type,sha256:asset.sha256,sizeBytes:asset.sizeBytes}))))
  if(digest!==manifest.manifestSha256)throw fail('Manifest checksum mismatch')
  return assets
}
async function loadBundle(manifest,expected,options={}){
  const assets=validateManifest(manifest,expected)
  const scope=options.accountScope||null
  if(scope!==cacheScope){clearCache();cacheScope=scope}
  const key=scope?JSON.stringify([scope,expected.workId,expected.pieceId,expected.contentVersion,manifest.quizVersion,manifest.manifestSha256]):null
  const cached=key&&verifiedCache.get(key)
  if(cached&&cached.until<=Date.now())verifiedCache.delete(key)
  const reusable=cached&&cached.until>Date.now()?cached:null
  const read=options.fetchBytes||requestBytes
  const values=await Promise.all(jsonTypes.map(async type=>{
    const asset=assets.get(type)
    if(!asset.mimeType.startsWith('application/json')||asset.sizeBytes>8*1024*1024)throw fail('Unsupported or oversized JSON resource')
    if(reusable)return JSON.parse(reusable.values[type])
    const raw=await read(asset)
    const bytes=raw instanceof ArrayBuffer?new Uint8Array(raw):ArrayBuffer.isView(raw)?new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength):null
    if(!bytes||bytes.length!==asset.sizeBytes||sha256Bytes(bytes)!==asset.sha256)throw fail('Resource checksum mismatch')
    try{return JSON.parse(decode(bytes))}catch(error){throw fail('Resource JSON is invalid')}
  }))
  const [cues,vocabulary,quiz,metadata]=values
  if(metadata?.schemaVersion!==1||metadata.workId!==expected.workId||metadata.pieceId!==expected.pieceId||metadata.contentVersion!==expected.contentVersion||quiz?.schemaVersion!==1||quiz.workId!==expected.workId||quiz.pieceId!==expected.pieceId||quiz.contentVersion!==expected.contentVersion||quiz.quizVersion!==manifest.quizVersion)throw fail('Resource version mismatch')
  const durationMs=manifest.durationMs
  if(!Number.isSafeInteger(durationMs)||durationMs<=0||!Array.isArray(cues)||!cues.length||!vocabulary||typeof vocabulary!=='object'||Array.isArray(vocabulary)||!Array.isArray(quiz.questions)||!quiz.questions.length)throw fail('Resource structure is invalid')
  let end=-1
  const cueIds=new Set()
  for(const cue of cues){
    if(!cue||typeof cue.id!=='string'||cueIds.has(cue.id)||!Number.isInteger(cue.startMs)||!Number.isInteger(cue.endMs)||cue.startMs<0||cue.startMs<end||cue.endMs<=cue.startMs||cue.endMs>durationMs+250||typeof cue.text!=='string')throw fail('Subtitle timeline is invalid')
    cueIds.add(cue.id);end=cue.endMs
    for(const token of cue.tokens||[]){if(token.vocabKey&&!vocabulary[token.vocabKey])throw fail('Contextual word entry is missing')}
  }
  const ids=new Set()
  for(const q of quiz.questions){if(!q||typeof q.id!=='string'||ids.has(q.id)||typeof q.q!=='string'||!Array.isArray(q.options)||q.options.length<2||!Number.isInteger(q.answer)||q.answer<0||q.answer>=q.options.length)throw fail('Quiz question is invalid');ids.add(q.id)}
  for(const entry of Object.values(vocabulary)){if(!entry||!/^ve-[a-f0-9]{12,64}$/.test(entry.entryId)||typeof entry.lemma!=='string')throw fail('Stable vocabulary entry is invalid')}
  if(key&&cacheScope===scope&&!reusable){
    if(verifiedCache.size>=4)verifiedCache.delete(verifiedCache.keys().next().value)
    verifiedCache.set(key,{until:Date.now()+5*60*1000,values:Object.fromEntries(jsonTypes.map((type,index)=>[type,JSON.stringify(values[index])]))})
  }
  return {workId:expected.workId,pieceId:expected.pieceId,contentVersion:expected.contentVersion,quizVersion:manifest.quizVersion,cues,vocabulary,quiz,metadata,duration:durationMs/1000,audioUrl:assets.get('audio').url,coverUrl:assets.get('cover').url}
}
module.exports={loadBundle,requestBytes,validateManifest,clearCache}
