// Shared, bounded multipart upload path for single chapters and folder imports.
import {assetTypes,hashFile} from './upload-core.mjs';
const fail=code=>Object.assign(new Error(code),{code});
export async function uploadBatchFiles(batch,{api,files,draft,persist,signal,progress=()=>{},verified=new WeakMap(),renewKeys=new Map()}){
 for(const item of [...batch.items].sort((a,b)=>assetTypes.indexOf(a.assetType)-assetTypes.indexOf(b.assetType))){
  signal.throwIfAborted();if(!['declared','uploading'].includes(item.status))continue;
  let id=item.uploadSessionId,status;
  if(id){status=await api('admin/upload-sessions/'+id);if(status.status==='completed')continue;if(status.status==='completing'){draft.completeKeys[item.assetType]??=crypto.randomUUID();await persist();await api('admin/upload-sessions/'+id+'/complete','POST',{parts:status.uploadedParts.map(({partNumber,etag})=>({partNumber,etag}))},draft.completeKeys[item.assetType]);continue;}}
  const file=files.get(item.assetType);if(!file||file.size!==item.sizeBytes)throw fail('RESELECT_ORIGINAL_FILE');
  let hash=verified.get(file);if(!hash){hash=await hashFile(file,signal,(done,total)=>progress(item.assetType,'SHA-256 校验 '+Math.round(done/total*100)+'%',done,total));verified.set(file,hash);}if(hash!==item.sha256)throw fail('FILE_CHECKSUM_MISMATCH');
  if(!id){draft.sessionKeys[item.assetType]??=crypto.randomUUID();await persist();const created=await api('admin/upload-sessions','POST',{batchId:batch.batchId,clientFileId:item.clientFileId},draft.sessionKeys[item.assetType]);id=created.uploadSessionId;}
  const key=renewKeys.get(id)??crypto.randomUUID();renewKeys.set(id,key);let lease;try{lease=await api('admin/upload-sessions/'+id+'/renew','POST',{},key);}catch(error){if(error.code==='UPLOAD_SESSION_EXPIRED')renewKeys.delete(id);throw error;}
  const parts=lease.uploadedParts.map(({partNumber,etag})=>({partNumber,etag}));let completed=lease.uploadedParts.reduce((sum,part)=>sum+part.sizeBytes,0);progress(item.assetType,'上传 '+Math.round(completed/file.size*100)+'%',completed,file.size);
  for(const part of lease.parts){signal.throwIfAborted();if(Date.parse(lease.expiresAt)<Date.now()+10000){renewKeys.delete(id);throw fail('UPLOAD_SESSION_EXPIRED');}const response=await fetch(part.uploadUrl,{method:'PUT',body:file.slice((part.partNumber-1)*lease.partSizeBytes,part.partNumber*lease.partSizeBytes),signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});if(!response.ok)throw fail('PART_UPLOAD_FAILED');const etag=response.headers.get('ETag');if(!etag)throw fail('STORAGE_CORS_ETAG_MISSING');parts.push({partNumber:part.partNumber,etag});completed+=Math.min(lease.partSizeBytes,file.size-(part.partNumber-1)*lease.partSizeBytes);progress(item.assetType,'上传 '+Math.round(completed/file.size*100)+'%',completed,file.size);}
  draft.completeKeys[item.assetType]??=crypto.randomUUID();await persist();await api('admin/upload-sessions/'+id+'/complete','POST',{parts:parts.sort((a,b)=>a.partNumber-b.partNumber)},draft.completeKeys[item.assetType]);progress(item.assetType,'上传完成',file.size,file.size);
 }
}
