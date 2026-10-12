import {uploadBatchFiles} from "./upload-flow.mjs";
import {initBulkUI} from "./bulk-ui.mjs";
import {assetTypes,hashFile,mimeFor,safeDraft} from "./upload-core.mjs";
const $=id=>document.getElementById(id),labels={audio:"音频",subtitles:"字幕",text:"原文",vocabulary:"词汇",quiz:"Quiz",cover:"封面",metadata:"元数据"};
let bulkUI=null;
let token="",owner="",generation=0,busy=false,controller=null,draft=null,batch=null;
const selected=new Map(),verified=new WeakMap(),renewKeys=new Map();
const newKey=()=>crypto.randomUUID();
function notice(message,error=false){$("notice").textContent=message;$("notice").classList.toggle("error",error);}
function syncButtons(){bulkUI?.sync();for(const id of ["batchId","list-status","list-work","list-piece","cancel-confirm"])$(id).disabled=busy||!owner;document.querySelectorAll("#file-inputs input").forEach(input=>input.disabled=busy||!owner||!!batch&&!["draft","uploading"].includes(batch.status));for(const id of ["list-query"])$(id).disabled=!owner||busy;$("list-more").disabled=!owner||busy||!listCursor;$("cancel-batch").disabled=!owner||busy||!batch?.canCancel||!$("cancel-confirm").checked;document.querySelectorAll("#items button,#batch-list button").forEach(button=>button.disabled=busy||!owner);for(const id of ["create","recover","draft"])$(id).disabled=!owner||busy;$("create").disabled=!owner||busy||!!batch;$("new-batch").disabled=!owner||busy;$("upload").disabled=!owner||!batch||busy||!["draft","uploading"].includes(batch.status);$("finalize").disabled=!owner||!batch||busy||!["draft","uploading"].includes(batch.status)||batch.items.some(item=>item.status!=="uploaded");$("refresh").disabled=!owner||!batch||busy;$("pause").disabled=!busy;$("disconnect").disabled=!token;$("connect-form").querySelector("button[type=submit]").disabled=busy;for(const id of ["workId","pieceId","version","source","sourceCommitSha"])$(id).disabled=busy||!!batch;}
function save(required=false){if(!draft||!owner||draft.owner!==owner){if(required)throw Object.assign(new Error("SESSION_CHANGED"),{code:"SESSION_CHANGED"});return;}try{localStorage.setItem("tingyue-ops-draft:"+owner,JSON.stringify(safeDraft(draft)));}catch{notice("浏览器草稿存储不可用；请保留批次 ID。",true);if(required)throw Object.assign(new Error("DRAFT_STORAGE_UNAVAILABLE"),{code:"DRAFT_STORAGE_UNAVAILABLE"});}}
async function api(path,method="GET",body,key){const captured=generation;controller?.signal.throwIfAborted();const response=await fetch("/api/v1/"+path,{method,headers:{Authorization:"Bearer "+token,...(body!==undefined?{"Content-Type":"application/json"}:{}),...(key?{"Idempotency-Key":key}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:controller?.signal,cache:"no-store",redirect:"error"});if(captured!==generation)throw new DOMException("Session changed","AbortError");const version=response.headers.get("X-API-Contract-Version");if(!/^api-contract-v2\.(?:[8-9]|[1-9]\d+)\./.test(version??""))throw Object.assign(new Error("API_CONTRACT_TOO_OLD"),{code:"API_CONTRACT_TOO_OLD"});const value=await response.json();if(captured!==generation)throw new DOMException("Session changed","AbortError");if(!response.ok)throw Object.assign(new Error(value.error?.code??"REQUEST_FAILED"),{code:value.error?.code,status:response.status});return value;}
async function run(task){if(busy)return;const scope=generation;busy=true;controller=new AbortController();syncButtons();try{await task();}catch(error){if(scope!==generation)return;if(error.name==="AbortError")notice("操作已暂停。服务端记录保留，可重新读取批次后继续。");else{notice("操作未完成："+(error.code??"NETWORK_OR_FILE_ERROR")+"。请检查会话、网络或内容文件后重试。",true);if(error.status===401||error.status===403)disconnect();}}finally{busy=false;controller=null;syncButtons();}}
function disconnect(){controller?.abort();bulkUI?.disconnect();generation++;token="";owner="";batch=null;draft=null;selected.clear();renewKeys.clear();batchRows=[];listCursor=null;listFilter=null;$("cancel-confirm").checked=false;$("job-detail").textContent="";renderBatchList();for(const type of assetTypes)$("file-"+type).value="";$("account").textContent="未连接";$("token").value="";$("batchId").value="";render();syncButtons();}
function render(){const body=$("items");body.replaceChildren();$("batch-status").textContent=batch?("版本 "+batch.contentVersion+" · "+batch.status):"尚未创建批次";for(const item of [...(batch?.items??[])].sort((a,b)=>assetTypes.indexOf(a.assetType)-assetTypes.indexOf(b.assetType))){const row=document.createElement("tr");row.dataset.type=item.assetType;for(const value of [labels[item.assetType],item.fileName,item.status+(item.errorCode?" · "+item.errorCode:""),item.jobStatus??"—"]){const cell=document.createElement("td");cell.textContent=value;row.append(cell);}const control=document.createElement("td");if(item.jobId){const inspect=document.createElement("button");inspect.className="secondary";inspect.textContent="查看原因 / 次数";inspect.addEventListener("click",()=>void run(()=>jobDetails(item.jobId)));control.append(inspect);if(item.canRetry||draft?.pendingRetry?.jobId===item.jobId){const retry=document.createElement("button");retry.textContent=draft?.pendingRetry?.jobId===item.jobId?"重试提交":"重新处理";retry.dataset.jobId=item.jobId;retry.addEventListener("click",()=>void run(()=>retryJob(item.jobId)));control.append(retry);}}row.append(control);body.append(row);}if(!batch){const row=document.createElement("tr"),cell=document.createElement("td");cell.colSpan=5;cell.textContent="连接会话并选择文件后开始。";row.append(cell);body.append(row);}$("content-state").textContent=batch?.content?("内容状态："+batch.content.status+"；"+(batch.content.status==="published"?"已发布。":"尚未发布，需要独立审核与发布流程。")):batch?("尚未生成可审核版本。未完成分片待清理："+batch.pendingUploadCleanup):"处理完成后仍需内容审核，不会自动发布。";syncButtons();}
function progress(type,text,done,total){const cell=document.querySelector('tr[data-type="'+type+'"] td:nth-child(3)');if(!cell){notice(text);return;}cell.replaceChildren(document.createTextNode(text));if(total){const bar=document.createElement("progress");bar.max=total;bar.value=done;cell.append(bar);}}
async function refresh(){$("job-detail").textContent="";const previousBatchId=batch?.batchId;const id=$("batchId").value.trim();if(!/^[a-f0-9-]{36}$/i.test(id))throw Object.assign(new Error("INVALID_BATCH_ID"),{code:"INVALID_BATCH_ID"});batch=await api("admin/ingestion-batches/"+id+"/recovery");if(previousBatchId!==id)$("cancel-confirm").checked=false;if(!draft||draft.batchId!==id)draft={owner,batchId:id,sessionKeys:{},completeKeys:{}};for(const [field,value] of Object.entries({workId:batch.workId,pieceId:batch.pieceId,version:batch.contentVersion,source:draft.input?.source??batch.source??"",sourceCommitSha:draft.input?.sourceCommitSha??batch.sourceCommitSha??""}))$(field).value=String(value);save();render();}
for(const type of assetTypes){const label=document.createElement("label");label.textContent=labels[type];const input=document.createElement("input");input.type="file";input.id="file-"+type;input.addEventListener("change",()=>{if(input.files[0])selected.set(type,input.files[0]);else selected.delete(type);});label.append(input);$("file-inputs").append(label);}
$("connect-form").addEventListener("submit",event=>{event.preventDefault();const supplied=$("token").value.trim();disconnect();void run(async()=>{token=supplied;const context=await api("admin/operations-context");owner=context.userId;$("account").textContent="已连接 · 管理员会话";$("disconnect").disabled=false;await queryBatches();notice("会话已验证。请选择资源或读取已有批次。");});});
$("disconnect").addEventListener("click",()=>{disconnect();notice("已清除本页会话；服务器登录状态未被撤销。");});
$("new-batch").addEventListener("click",()=>{const previous=batch?.batchId;batch=null;draft=null;$("batchId").value="";selected.clear();for(const type of assetTypes)$("file-"+type).value="";render();notice(previous?"已切换至新批次填写；原批次 "+previous+" 保留在服务端。":"请填写新的内容包声明。");});
$("pause").addEventListener("click",()=>controller?.abort());
$("batch-form").addEventListener("submit",event=>{event.preventDefault();void run(async()=>{
 if(batch)throw Object.assign(new Error("EXISTING_BATCH"),{code:"EXISTING_BATCH"});
 const items=[];for(const type of assetTypes){const file=selected.get(type);if(!file||!file.size)throw Object.assign(new Error("MISSING_FILE"),{code:"MISSING_FILE"});const sha256=verified.get(file)??await hashFile(file,controller.signal,(done,total)=>notice(labels[type]+" SHA-256 校验 "+Math.round(done/total*100)+"%"));verified.set(file,sha256);items.push({clientFileId:type,assetType:type,fileName:file.name,sizeBytes:file.size,mimeType:mimeFor(type,file.name),sha256});}
 const input={workId:$("workId").value.trim(),pieceId:$("pieceId").value.trim(),contentVersion:Number($("version").value),source:$("source").value.trim(),sourceCommitSha:$("sourceCommitSha").value.trim(),toolVersion:"operations-web/1",items};
 if(!draft?.input||JSON.stringify(input)!==JSON.stringify(draft.input))draft={owner,input,createKey:newKey(),sessionKeys:{},completeKeys:{}};save(true);
 const created=await api("admin/ingestion-batches","POST",draft.input,draft.createKey);draft.batchId=created.batchId;$("batchId").value=created.batchId;save();await refresh();notice("批次已创建。声明不可更改，可开始上传。");
});});
$("recover").addEventListener("click",()=>void run(async()=>{await refresh();notice("已读取批次。上传未完成时，请重新选择原文件。");}));
$("draft").addEventListener("click",()=>void run(async()=>{let stored;try{stored=JSON.parse(localStorage.getItem("tingyue-ops-draft:"+owner));}catch{throw Object.assign(new Error("INVALID_DRAFT"),{code:"INVALID_DRAFT"});}if(!stored||stored.owner!==owner)throw Object.assign(new Error("DRAFT_NOT_FOUND"),{code:"DRAFT_NOT_FOUND"});draft=safeDraft(stored);if(!draft.batchId&&draft.input){const created=await api("admin/ingestion-batches","POST",draft.input,draft.createKey);draft.batchId=created.batchId;save();}$("batchId").value=draft.batchId??"";await refresh();notice("草稿已恢复。仅上传未完成的资源。");}));
$("refresh").addEventListener("click",()=>void run(async()=>{await refresh();notice("处理状态已刷新。");}));
$("upload").addEventListener("click",()=>void run(async()=>{
 await refresh();await uploadBatchFiles(batch,{api,files:selected,draft,persist:()=>save(true),signal:controller.signal,progress,verified,renewKeys});await refresh();notice("上传完成。请确认后点击提交处理；内容仍未发布。");
}));
$("finalize").addEventListener("click",()=>void run(async()=>{draft.finalizeKey??=newKey();save(true);await api("admin/ingestion-batches/"+batch.batchId+"/finalize","POST",{},draft.finalizeKey);await refresh();notice("已提交后台校验。稍后刷新查看结果；未进行审核或发布。");}));

let batchRows=[],listCursor=null,listFilter=null;
const jobReasons={ASSET_CHECKSUM_MISMATCH:"实际文件与声明摘要不一致；请用正确资源创建新版本。",SUBTITLE_VALIDATION_FAILED:"字幕编码、时间轴或内容校验未通过；请修正后创建新版本。",DEPENDENCY_UNAVAILABLE:"对象存储等依赖暂时不可用，可在剩余次数内重试。",INGESTION_JOB_FAILED:"处理未完成，请检查资源格式及脱敏服务端日志。"};
function filters(){return{status:$("list-status").value,workId:$("list-work").value.trim(),pieceId:$("list-piece").value.trim(),limit:20};}
function renderBatchList(){
 const body=$("batch-list");body.replaceChildren();
 for(const item of batchRows){
  const row=document.createElement("tr");for(const value of [item.workId+" / "+item.pieceId,"v"+item.contentVersion+" · "+item.status,item.succeededCount+" / "+item.totalCount+"，失败 "+item.failedCount,item.createdAt]){const cell=document.createElement("td");cell.textContent=String(value);row.append(cell);}
  const cell=document.createElement("td"),button=document.createElement("button");button.className="secondary";button.textContent="打开";button.disabled=busy;button.addEventListener("click",()=>void run(async()=>{$("batchId").value=item.batchId;await refresh();notice("已读取所选批次。");}));cell.append(button);row.append(cell);body.append(row);
 }
 if(!batchRows.length){const row=document.createElement("tr"),cell=document.createElement("td");cell.colSpan=5;cell.textContent=owner?"没有匹配的批次。":"连接管理员会话后查看。";row.append(cell);body.append(row);}
 syncButtons();
}
async function queryBatches(more=false){
 const current=filters();if(more&&JSON.stringify(current)!==JSON.stringify(listFilter))throw Object.assign(new Error("FILTER_CHANGED"),{code:"FILTER_CHANGED"});
 if(!more){listFilter=current;listCursor=null;batchRows=[];}
 const params=new URLSearchParams();for(const[key,value]of Object.entries(current))if(value!=="")params.set(key,String(value));if(more&&listCursor)params.set("cursor",listCursor);
 const response=await api("admin/ingestion-batches?"+params);batchRows=more?[...batchRows,...response.items.filter(item=>!batchRows.some(old=>old.batchId===item.batchId))]:response.items;listCursor=response.nextCursor;renderBatchList();
}
async function jobDetails(id){
 const value=await api("admin/ingestion-jobs/"+id);if(value.batchId!==batch?.batchId)throw Object.assign(new Error("JOB_BATCH_MISMATCH"),{code:"JOB_BATCH_MISMATCH"});
 $("job-detail").textContent=value.assetType+" · "+value.status+" · 已尝试 "+value.attemptCount+" / "+value.maxAttempts+"；"+(value.errorCode?(jobReasons[value.errorCode]??"需检查脱敏服务端日志。"):"当前没有失败记录。")+(value.remainingAttempts===0?" 累计次数已耗尽，不可重置重试。":"");
 return value;
}
async function retryJob(id){
 const value=await jobDetails(id);if(draft.pendingRetry&&draft.pendingRetry.jobId!==id)throw Object.assign(new Error("PENDING_RETRY"),{code:"PENDING_RETRY"});
 if(!draft.pendingRetry){if(!value.canRetry)throw Object.assign(new Error("INGESTION_JOB_FAILED"),{code:"INGESTION_JOB_FAILED"});draft.retryKeys??={};const identity=id+":"+value.dispatchGeneration;draft.retryKeys[identity]??=newKey();draft.pendingRetry={jobId:id,key:draft.retryKeys[identity]};save(true);}
 await api("admin/ingestion-jobs/"+id+"/retry","POST",{},draft.pendingRetry.key);draft.pendingRetry=null;save(true);await refresh();notice("已提交处理重试；累计尝试次数不会重置。稍后刷新查看结果。");
}
$("list-query").addEventListener("click",()=>void run(()=>queryBatches()));
$("list-more").addEventListener("click",()=>void run(()=>queryBatches(true)));
$("cancel-confirm").addEventListener("change",syncButtons);
$("cancel-batch").addEventListener("click",()=>void run(async()=>{
 if(!$("cancel-confirm").checked||!batch)throw Object.assign(new Error("CANCEL_CONFIRMATION_REQUIRED"),{code:"CANCEL_CONFIRMATION_REQUIRED"});
 draft.cancelKey??=newKey();save(true);await api("admin/ingestion-batches/"+batch.batchId+"/cancel","POST",{},draft.cancelKey);$("cancel-confirm").checked=false;await refresh();await queryBatches();notice("批次已取消，未完成分片清理已确认；已经上传的文件保留。");
}));

bulkUI=initBulkUI({api,run,notice,getOwner:()=>owner,getBusy:()=>busy,getSignal:()=>controller?.signal,openBatch:async id=>{$("batchId").value=id;await refresh();notice("已读取章节批次；可查看失败原因或重试。");}});
window.addEventListener("pagehide",()=>controller?.abort());render();
