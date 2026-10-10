// Signed asset requests deliberately carry no account headers or tokens.
async function readText(manifest, runtime) {
  const asset=(manifest.assets||[]).find(a=>a.type==='text')
  if(!asset || asset.mimeType!=='text/plain' || !(asset.sizeBytes>0 && asset.sizeBytes<=65536) || !(Date.parse(asset.expiresAt)>Date.now()))throw Error('正文资源无效或已过期')
  if(!/^https:\/\//.test(asset.url) && !/^http:\/\/127\.0\.0\.1:59000\//.test(asset.url))throw Error('正文地址无效')
  const result=await new Promise((resolve,reject)=>runtime.request({url:asset.url,method:'GET',header:{},dataType:'text',responseType:'text',timeout:15000,success:resolve,fail:reject}))
  if(result.statusCode!==200 || typeof result.data!=='string' || !result.data.length || result.data.length>65536)throw Error('正文读取失败')
  return result.data
}
module.exports={readText}
