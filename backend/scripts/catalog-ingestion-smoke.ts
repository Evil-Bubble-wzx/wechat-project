import assert from "node:assert/strict";
import {createHash,randomBytes,randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import {basename} from "node:path";
import {fileURLToPath} from "node:url";
import {DeleteObjectsCommand,GetObjectCommand,ListObjectsV2Command,S3Client,UploadPartCommand} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import {Queue,QueueEvents,Worker,UnrecoverableError} from "bullmq";
import {Ajv2020} from "ajv/dist/2020.js";
import type {FormatsPlugin} from "ajv-formats";
import pg from "pg";
import {createApp} from "../src/api/app.ts";
import {ApiError} from "../src/api/errors.ts";
import {SessionService} from "../src/auth/session-service.ts";
import {loadConfig} from "../src/config.ts";
import {ContentService} from "../src/content/service.ts";
import {migrateUp,rollbackOne} from "../src/database/migrator.ts";
import {IngestionProcessor,IngestionProcessingError} from "../src/ingestion/processor.ts";
import {IngestionService,type IngestionJobPayload} from "../src/ingestion/service.ts";
import {QuizService} from "../src/quiz/service.ts";
import {RankingQueryService} from "../src/ranking/query-service.ts";
import {parseRedisConnection} from "../src/queue.ts";
import {ProgressSyncService} from "../src/sync/progress-sync-service.ts";
import {ReaderLibraryService} from "../src/sync/reader-library-service.ts";
import {SavedWordSyncService} from "../src/sync/saved-word-sync-service.ts";

// Fixture approvals below apply only to random local test content, never the original Peter release.
const require=createRequire(import.meta.url),config=loadConfig();
if(!["local","test"].includes(config.appEnv)||!/^postgresql:\/\/[^@]+@127\.0\.0\.1:15432\/tingyue_test$/.test(config.databaseUrl)||config.objectStorage.endpoint!=="127.0.0.1")throw new Error("Use explicit local test database and object storage only");
const suffix=randomBytes(8).toString("hex"),schema="catalog_test_"+suffix;
assert.match(schema,/^catalog_test_[a-f0-9]{16}$/);
const workId="catalog-"+suffix,pieceId=workId+"-01";
const root=fileURLToPath(new URL("../../content/peter-rabbit/peter-rabbit-01/",import.meta.url));
const files=[
 ["audio","source/audio-original.mp3","audio/mpeg"],["cover","source/cover/peter-rabbit-independent.svg","image/svg+xml"],
 ["text","source/text-project-gutenberg-14838.txt","text/plain"],["subtitles","dist/cues.json","application/json"],
 ["vocabulary","dist/vocab.json","application/json"],["quiz","dist/quiz.json","application/json"],["metadata","dist/metadata.json","application/json"]
]as const;
const admin=new pg.Pool({connectionString:config.databaseUrl,max:1});
const pool=new pg.Pool({connectionString:config.databaseUrl,max:8,options:"-c search_path="+schema+",public"});
const s3=new S3Client({endpoint:"http://"+config.objectStorage.endpoint+":"+config.objectStorage.port,region:"us-east-1",forcePathStyle:true,credentials:{accessKeyId:config.objectStorage.accessKey,secretAccessKey:config.objectStorage.secretKey}});
const queueName="catalog-smoke-"+suffix,connection=parseRedisConnection(config.redisUrl);
const queue=new Queue<IngestionJobPayload>(queueName,{connection}),events=new QueueEvents(queueName,{connection});
const processor=new IngestionProcessor(pool,s3,config.ffprobePath);
const worker=new Worker<IngestionJobPayload>(queueName,async job=>{
 try{await processor.process(job.data.processingJobId,job.attemptsMade+1,Number(job.opts.attempts)||1,job.data.dispatchGeneration??0)}
 catch(error){if(error instanceof IngestionProcessingError&&!error.retryable)throw new UnrecoverableError(error.message);throw error}
},{connection,concurrency:7});
const ingest=new IngestionService(pool,s3,queue,config.objectStorage.incomingBucket,config.objectStorage.publishedBucket,config.auth.identityHashKeyBase64);
const content=new ContentService(pool,s3,config.auth.identityHashKeyBase64);
const sessions=new SessionService(pool,{exchangeCode:async()=>({openid:"catalog-local-"+suffix})},config);
const app=createApp({logger:false,sessionService:sessions,ingestionService:ingest,contentService:content,rankingService:new RankingQueryService(pool,config.auth.identityHashKeyBase64),quizService:new QuizService(pool),progressSyncService:new ProgressSyncService(pool),readerLibraryService:new ReaderLibraryService(pool,config.auth.identityHashKeyBase64),savedWordSyncService:new SavedWordSyncService(pool,config.auth.identityHashKeyBase64)});
const api=require("../../miniprogram/services/api.js"),host=require("../../miniprogram/services/host.js"),catalog=require("../../miniprogram/modules/catalog/remote-catalog.js");
const resources=require("../../miniprogram/modules/catalog/remote-resources.js"),sync=require("../../miniprogram/modules/sync/progress-sync.js");
const {createPage}=require("../../miniprogram/ui/controller.js"),savedApi={...api},previousWx=(globalThis as any).wx;
const storage=new Map(),downloads:string[]=[];
(globalThis as any).wx={
 login:({success}:any)=>success({code:"catalog-"+suffix}),getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value),
 showToast:()=>{},getAccountInfoSync:()=>({miniProgram:{envVersion:"develop"}}),
 request:(options:any)=>{assert.equal(options.header?.Authorization,undefined);downloads.push(options.url);void fetch(options.url).then(async response=>options.success({statusCode:response.status,data:await response.arrayBuffer()})).catch(options.fail)}
};
let address="";
const client=api.createBackendApi({configuration:{enabled:true,apiRoot:"http://127.0.0.1/api/v1",contractVersion:"api-contract-v2.9.0"},runtime:(globalThis as any).wx,maxRetries:0,
 transport:async(request:any)=>{const url=new URL(request.url);const response=await fetch(address+url.pathname+url.search,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body)});return{statusCode:response.status,data:await response.json(),headers:Object.fromEntries(response.headers)}}
});
for(const key of Object.keys(client))if(typeof client[key]==="function"&&key in api)api[key]=client[key];
const libraryManager=require("../../miniprogram/modules/sync/library-sync.js").createLibrarySyncManager({api:client,host,runtime:(globalThis as any).wx,schedule:()=>null});
const wordManager=require("../../miniprogram/modules/sync/saved-word-sync.js").createSavedWordSyncManager({api:client,host,runtime:(globalThis as any).wx,schedule:()=>null});
function page(route:string){const value=createPage(route);value.setData=(patch:unknown)=>Object.assign(value.data,patch);return value}
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
async function adminRequest(path:string,body:unknown,key:string,status=200){
 const response=await fetch(address+"/api/v1/admin/"+path,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+client._tokenStore.getAccessToken(),"idempotency-key":key},body:JSON.stringify(body)});
 const value=await response.json();assert.equal(response.status,status,JSON.stringify(value.error??{status:response.status}));return value;
}
function clock(ms:number,format:"srt"|"vtt"){return String(Math.floor(ms/3600000)).padStart(2,"0")+":"+String(Math.floor(ms/60000)%60).padStart(2,"0")+":"+String(Math.floor(ms/1000)%60).padStart(2,"0")+(format==="srt"?",":".")+String(ms%1000).padStart(3,"0")}
async function candidate(version:number,actor:string,format:"json"|"srt"|"vtt"="json",failure?:"overlap"|"duration"|"checksum"){
 let sourceCues:any[]=[];
 const data=await Promise.all(files.map(async([type,path,declaredMime])=>{
  let mimeType:string=declaredMime,fileName=basename(path);
  let bytes=await readFile(root+path);
  if(type==="metadata"||type==="quiz"){
   const value=JSON.parse(bytes.toString("utf8"));Object.assign(value,{workId,pieceId,contentVersion:version});
   if(type==="metadata")Object.assign(value,{titleZh:"隔离目录测试",author:"Test Author "+version,series:"Test Series "+version,level:version===1?"4.2":"5.1",wordCount:{value:version===1?952:1000}});
   bytes=Buffer.from(JSON.stringify(value));
  }
  if(type==="subtitles"&&format!=="json"){
   sourceCues=JSON.parse(bytes.toString());sourceCues[0].text=format.toUpperCase()+" import: 你好, café & tea.\nSecond line.";
   if(failure==="overlap")sourceCues[1].startMs=sourceCues[0].endMs-1;
   if(failure==="duration")sourceCues[sourceCues.length-1].endMs=999000;
   const escape=(text:string)=>text.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
   const blocks=sourceCues.map((cue,index)=>(format==="vtt"?cue.id:String(index+1))+"\n"+clock(cue.startMs,format)+" --> "+clock(cue.endMs,format)+"\n"+(index===0?"<i>"+escape(cue.text)+"</i>":escape(cue.text))).join("\n\n");
   const comments=format==="vtt"?"NOTE large streaming fixture\n"+("x".repeat(32000)+"\n").repeat(300)+"\n":"";
   bytes=Buffer.from("\ufeff"+(format==="vtt"?"WEBVTT\n\n"+comments:"")+blocks.replace(/\n/g,"\r\n")+"\n");
   mimeType=format==="vtt"?"text/vtt":"application/x-subrip";fileName="raw-subtitles."+format;
  }
  return{type,mimeType,bytes,fileName}
 }));
 const input={source:"isolated-catalog-smoke",sourceCommitSha:"c50ad84",toolVersion:"catalog-smoke/1",workId,pieceId,contentVersion:version,
  items:data.map(file=>({clientFileId:file.type,assetType:file.type,fileName:file.fileName,mimeType:file.mimeType,sizeBytes:file.bytes.length,sha256:failure==="checksum"&&file.type==="subtitles"?"e".repeat(64):digest(file.bytes)}))};
 let batch:any;
 if(version===7&&process.argv.includes("--operations-browser")){
  const originalSend=s3.send.bind(s3);let failed=false;
  try{
   batch=await require("../../tools/operations-browser-check.js")(address,client._tokenStore.getAccessToken(),input,data,{
    expire:async(batchId:string)=>{
     await pool.query("UPDATE upload_sessions SET expires_at=created_at+interval '1 millisecond' WHERE ingestion_item_id IN (SELECT id FROM ingestion_items WHERE batch_id=$1) AND status='active'",[batchId]);
     const upload=(await pool.query("SELECT u.id FROM upload_sessions u JOIN ingestion_items i ON i.id=u.ingestion_item_id WHERE i.batch_id=$1 AND i.asset_type='subtitles'",[batchId])).rows[0]!;
     const state=await ingest.getUploadSession(upload.id,actor);assert.equal(state.status,"expired");assert.equal(state.uploadedParts.length,1);
    },
    armCompletionFailure:async(batchId:string)=>{
     (s3 as any).send=async(command:any,...args:any[])=>{
      const value=await (originalSend as any)(command,...args);
      if(!failed&&command.constructor.name==="CompleteMultipartUploadCommand"&&command.input.Key.startsWith("incoming/"+batchId+"/")&&command.input.Key.endsWith("/peter-rabbit-independent.svg")){failed=true;throw new Error("Isolated post-storage completion failure");}
      return value;
     };
    },
    assertDurableIntent:async(batchId:string)=>{
     (s3 as any).send=originalSend;assert.equal(failed,true);
     const stored=(await pool.query("SELECT u.status,u.completion_parts,u.completion_request_hash FROM upload_sessions u JOIN ingestion_items i ON i.id=u.ingestion_item_id WHERE i.batch_id=$1 AND i.asset_type='cover'",[batchId])).rows[0]!;
     assert.equal(stored.status,"active");assert.ok(stored.completion_request_hash);assert.equal(stored.completion_parts.length,1);
     const response=await fetch(address+"/api/v1/admin/ingestion-batches/"+batchId+"/recovery",{headers:{authorization:"Bearer "+client._tokenStore.getAccessToken()}});assert.equal(response.status,200);
     const current=await response.json();assert.equal(current.items.some((item:any)=>item.jobId),false,"Webpage must not auto-finalize");
    }
   });
  }finally{(s3 as any).send=originalSend;}
 }else{
 batch=await adminRequest("ingestion-batches",input,"catalog-batch-"+suffix+"-"+version,201);
 assert.equal((await pool.query("SELECT metadata->>'contractVersion' AS version FROM ingestion_batches WHERE id=$1",[batch.batchId])).rows[0]!.version,"api-contract-v2.9.0");
 assert.equal((await adminRequest("ingestion-batches",input,"catalog-batch-"+suffix+"-"+version,201)).batchId,batch.batchId);
 for(const file of data){
  const upload=await adminRequest("upload-sessions",{batchId:batch.batchId,clientFileId:file.type},"catalog-upload-"+suffix+"-"+version+"-"+file.type,201);
  const stored=(await pool.query("SELECT bucket,object_key,multipart_upload_id FROM upload_sessions WHERE id=$1",[upload.uploadSessionId])).rows[0]!;
  assert.equal(upload.parts.length,Math.ceil(file.bytes.length/upload.partSizeBytes));
  const parts=[];
  for(const declaration of upload.parts){
   const bytes=file.bytes.subarray((declaration.partNumber-1)*upload.partSizeBytes,declaration.partNumber*upload.partSizeBytes);
   const part=await s3.send(new UploadPartCommand({Bucket:stored.bucket,Key:stored.object_key,UploadId:stored.multipart_upload_id,PartNumber:declaration.partNumber,Body:bytes,ContentLength:bytes.length}));
   parts.push({partNumber:declaration.partNumber,etag:part.ETag!});
  }
  await adminRequest("upload-sessions/"+upload.uploadSessionId+"/complete",{parts},"catalog-complete-"+suffix+"-"+version+"-"+file.type);
 }
 }
 await events.waitUntilReady();await adminRequest("ingestion-batches/"+batch.batchId+"/finalize",{},"catalog-finalize-"+suffix+"-"+version,202);
 const jobs=(await pool.query("SELECT j.id FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=$1",[batch.batchId])).rows;
 assert.equal(jobs.length,7);
 const finished=await Promise.allSettled(jobs.map(async row=>{const job=await queue.getJob("ingestion-"+row.id);assert.ok(job);await job.waitUntilFinished(events,45000)}));
 if(failure){
  assert.ok(finished.some(result=>result.status==="rejected"));assert.equal((await ingest.getBatch(batch.batchId)).status,"partial_failed");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM content_versions WHERE piece_id=$1 AND content_version=$2",[pieceId,version])).rows[0]!.n,0);
  const failed=(await pool.query("SELECT error_code FROM ingestion_items WHERE batch_id=$1 AND status='failed'",[batch.batchId])).rows;
  assert.ok(failed.some(row=>row.error_code===(failure==="checksum"?"ASSET_CHECKSUM_MISMATCH":"SUBTITLE_VALIDATION_FAILED")));return "";
 }
 assert.ok(finished.every(result=>result.status==="fulfilled"),JSON.stringify(finished));
 assert.equal((await ingest.getBatch(batch.batchId)).status,"ready_for_review");
 const value=(await pool.query("SELECT * FROM content_versions WHERE piece_id=$1 AND content_version=$2",[pieceId,version])).rows[0]!;
 assert.equal(value.publishable,false);assert.equal(value.catalog_metadata.author,"Test Author "+version);
 assert.ok((await pool.query("SELECT duration_ms FROM content_assets WHERE piece_id=$1 AND content_version=$2 AND asset_type='audio'",[pieceId,version])).rows[0]!.duration_ms>300000);
 assert.equal((await pool.query("SELECT status FROM quiz_packages WHERE piece_id=$1 AND content_version=$2",[pieceId,version])).rows[0]!.status,"draft");
 if(format!=="json"){
  const source=data.find(file=>file.type==="subtitles")!;
  const ready=(await pool.query("SELECT pa.*,original.sha256 AS source_sha256,original.size_bytes AS source_size,original.object_key AS source_key FROM processing_artifacts pa JOIN processing_artifacts original ON original.id=pa.parent_artifact_id JOIN processing_jobs j ON j.id=pa.processing_job_id JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=$1 AND pa.artifact_kind='ready' AND i.asset_type='subtitles'",[batch.batchId])).rows[0]!;
  assert.equal(ready.source_sha256.trim(),digest(source.bytes));assert.equal(Number(ready.source_size),source.bytes.length);assert.equal(ready.mime_type,"application/json");assert.notEqual(ready.sha256.trim(),ready.source_sha256.trim());
  const normalized=Buffer.from(await(await s3.send(new GetObjectCommand({Bucket:ready.bucket,Key:ready.object_key}))).Body!.transformToByteArray());
  assert.equal(digest(normalized),ready.sha256.trim());assert.equal(normalized.length,Number(ready.size_bytes));
  const cues=JSON.parse(normalized.toString());assert.equal(cues.length,sourceCues.length);
  for(const [index,cue] of cues.entries())assert.deepEqual([cue.text,cue.startMs,cue.endMs,cue.tokens],[sourceCues[index].text,sourceCues[index].startMs,sourceCues[index].endMs,[]]);
  assert.equal(ready.validation.conversion.sourceFormat,format);assert.equal(ready.validation.conversion.sourceSha256,digest(source.bytes));
  if(format==="vtt")assert.ok(source.bytes.length>8*1024*1024);
  const asset=(await pool.query("SELECT sha256,size_bytes,mime_type FROM content_assets WHERE piece_id=$1 AND content_version=$2 AND asset_type='subtitles'",[pieceId,version])).rows[0]!;
  assert.deepEqual([asset.sha256.trim(),Number(asset.size_bytes),asset.mime_type],[digest(normalized),normalized.length,"application/json"]);
  const original=Buffer.from(await(await s3.send(new GetObjectCommand({Bucket:ready.bucket,Key:ready.source_key}))).Body!.transformToByteArray());assert.deepEqual(original,source.bytes);
  const job=jobs.find(row=>row.id===ready.processing_job_id)!;await processor.process(job.id,2,5);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM processing_artifacts WHERE processing_job_id=$1",[job.id])).rows[0]!.n,2);
 }
 await assert.rejects(ingest.publishContentVersion(value.id,{reviewId:randomUUID(),expectedCurrentContentVersion:version===1?null:version===7?3:version-1},actor,"no-approval"),(error:unknown)=>error instanceof ApiError&&error.code==="PUBLISH_GATE_NOT_SATISFIED");
 return value.id as string;
}
async function approveFixture(id:string,actor:string,current:number|null){
 await pool.query("UPDATE content_versions SET publishable=true WHERE id=$1",[id]);let reviewId:string|undefined;
 for(const gate of["C-03","C-05"])reviewId=(await pool.query("INSERT INTO content_reviews(content_version_id,gate_key,reviewer_actor_id,decision,reviewed_at,notes) VALUES($1,$2,'isolated-test-fixture','approved',now(),'Not a real review') RETURNING id",[id,gate])).rows[0]!.id;
 await ingest.publishContentVersion(id,{reviewId:reviewId!,expectedCurrentContentVersion:current},actor,"fixture-publish");
}
async function cleanupObjects(){
 const rows=(await pool.query("SELECT bucket,object_key FROM upload_sessions UNION SELECT bucket,object_key FROM processing_artifacts UNION SELECT bucket,object_key FROM content_assets")).rows;
 const batches=new Set((await pool.query("SELECT id FROM ingestion_batches")).rows.map(row=>row.id));
 // Include deterministic ready objects whose final DB transaction was rejected by cross-resource validation.
 for(const bucket of new Set([config.objectStorage.incomingBucket,config.objectStorage.publishedBucket])){
  for(const prefix of ["ready/"+pieceId+"/","published/"+pieceId+"/"]){
   let cursor:string|undefined;
   do{const page=await s3.send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,ContinuationToken:cursor}));
    for(const item of page.Contents??[])if(item.Key){assert.ok(item.Key.startsWith(prefix));if(!rows.some(row=>row.bucket===bucket&&row.object_key===item.Key))rows.push({bucket,object_key:item.Key})}
    cursor=page.IsTruncated?page.NextContinuationToken:undefined;
   }while(cursor);
  }
 }
 for(const row of rows)assert.ok(row.object_key.startsWith("ready/"+pieceId+"/")||row.object_key.startsWith("published/"+pieceId+"/")||[...batches].some(id=>row.object_key.startsWith("incoming/"+id+"/")),"Refuse deleting unrelated key "+row.object_key);
 for(const bucket of new Set(rows.map(row=>row.bucket))){const keys=rows.filter(row=>row.bucket===bucket).map(row=>({Key:row.object_key}));for(let i=0;i<keys.length;i+=1000)await s3.send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:keys.slice(i,i+1000),Quiet:true}}));}
}
async function main(){
 await admin.query('CREATE SCHEMA "'+schema+'"');
 let readerPage:any;
 try{
  await migrateUp(pool,{schema});address=await app.listen({host:"127.0.0.1",port:0});const user=await client.loginWechat(),actor=user.userId;assert.equal(client.dynamicCatalogAvailable(),true);
  await pool.query("INSERT INTO user_roles(user_id,role,granted_by) VALUES($1,'content_admin','isolated-catalog-fixture')",[actor]);
  await pool.query("INSERT INTO works(id,title) VALUES($1,'Isolated Cloud Book')",[workId]);
  await pool.query("INSERT INTO pieces(id,work_id,title) VALUES($1,$2,'Isolated Chapter')",[pieceId,workId]);
  assert.deepEqual((await client.listWorks()).items,[]);
  const first=await candidate(1,actor);assert.deepEqual((await client.listWorks()).items,[]);await approveFixture(first,actor,null);
  const list=await client.listWorks(undefined,50,{query:"test author 1",category:"fiction"});
  assert.equal(list.items.length,1);assert.equal(list.items[0].workId,workId);assert.equal(list.items[0].metadata.pageCount,null);
  const doc=JSON.parse(await readFile(new URL("../contracts/schemas/api-v1.schema.json",import.meta.url),"utf8"));
  const ajv=new Ajv2020({strict:true});(require("ajv-formats")as FormatsPlugin)(ajv);ajv.addSchema(doc);
  for(const[definition,value]of[["WorksResponse",list],["WorkResponse",await client.getWork(workId)],["ManifestResponse",await client.getManifest(pieceId,1)]]){
   const validator=ajv.compile({$ref:doc.$id+"#/$defs/"+definition});assert.equal(validator(value),true,JSON.stringify(validator.errors));
  }
  const library=page("library");library.data.query="test author 1";await library.loadRemoteCatalog();assert.deepEqual(library.data.shown.map((book:any)=>book.id),[workId]);
  const quiz=page("quiz");quiz.data.book={...catalog.get(workId),chapterId:pieceId};quiz.refresh();quiz.setupQuiz();assert.equal(quiz.questions.length,0);
  await quiz.loadRemoteContent();assert.equal(quiz.data.remoteContentStatus,"ready");assert.equal(quiz.quizPackage.workId,workId);assert.equal(quiz.questions.length,10);assert.ok(quiz.cuesForBook().length>50);
  const bundle=await resources.loadBundle(await client.getManifest(pieceId,1),{workId,pieceId,contentVersion:1});assert.equal(bundle.quizVersion,1);
  const audioRow=(await pool.query("SELECT bucket,object_key FROM content_assets WHERE piece_id=$1 AND content_version=1 AND asset_type='audio'",[pieceId])).rows[0]!;
  const expiredUrl=await getSignedUrl(s3,new GetObjectCommand({Bucket:audioRow.bucket,Key:audioRow.object_key}),{expiresIn:1,signingDate:new Date(Date.now()-60000)});
  assert.equal((await fetch(expiredUrl)).status,403);
  const audioManifest=await client.getManifest(pieceId,1),audioAsset=audioManifest.assets.find((asset:any)=>asset.type==='audio')!;
  const leaseBook={id:workId,workId,pieceId,contentVersion:1,duration:audioManifest.durationMs/1000,localAudio:expiredUrl,audioAccountScope:actor,remoteManifest:{...audioManifest,assets:audioManifest.assets.map((asset:any)=>asset.type==='audio'?{...asset,url:expiredUrl,expiresAt:new Date(Date.now()-60000).toISOString()}:asset)}};
  const renewAudio=require("../../miniprogram/modules/listen-read/audio-lease.js").createAudioLeaseResolver({api:client,host});
  const renewedBook=await renewAudio(leaseBook),freshAudio=await fetch(renewedBook.localAudio,{headers:{Range:"bytes=0-1023"}});
  assert.equal(freshAudio.status,206);assert.equal((await freshAudio.arrayBuffer()).byteLength,1024);
  const renewedBytes=Buffer.from(await(await fetch(renewedBook.localAudio)).arrayBuffer());assert.equal(renewedBytes.length,audioAsset.sizeBytes);assert.equal(digest(renewedBytes),audioAsset.sha256);
  libraryManager.activate(actor,{sync:false});assert.equal(libraryManager.record("favorite",workId,false),true);assert.equal(libraryManager.record("open",workId,false),true);await libraryManager.trigger("test",true);
  assert.equal(libraryManager.status().status,"synced");assert.equal(host.read().favorites.includes(workId),true);assert.equal(host.read().recent[0],workId);
  const vocabKey=Object.keys(bundle.vocabulary)[0],entry=bundle.vocabulary[vocabKey];
  wordManager.activate(actor,{sync:false});assert.equal(wordManager.saveWord({entryId:entry.entryId,pieceId,contentVersion:1,vocabKey,surface:entry.lemma,lemma:entry.lemma},false),true);await wordManager.trigger("test",true);
  assert.equal(wordManager.status().status,"synced");assert.equal(host.read().savedWordEntries[entry.entryId].pieceId,pieceId);
  const now=new Date().toISOString(),verified=await client.submitQuiz({schemaVersion:1,attemptId:"catalog-attempt-"+suffix,workId,pieceId,contentVersion:1,quizVersion:1,questionIds:quiz.questions.map((q:any)=>q.id),selectedOptions:quiz.questions.map((q:any)=>q.answer),startedAt:now,submittedAt:now});
  assert.equal(verified.status,"server_verified");assert.equal(verified.score,100);assert.ok(Number(verified.learningScore.totalPoints)>0);
  const progress=await client.putProgress(pieceId,{schemaVersion:1,mutationId:"catalog-progress-"+suffix,baseRevision:"0",contentVersion:1,checkpointMs:10000,listenedRangesMs:[[0,10000]]});assert.equal(progress.progress.listenedMs,10000);
  const second=await candidate(2,actor,"srt");await approveFixture(second,actor,1);await quiz.loadRemoteContent();assert.equal(quiz.data.book.contentVersion,2);assert.equal(quiz.quizPackage.contentVersion,2);
  assert.ok(quiz.cuesForBook()[0].text.startsWith("SRT import:"));
  if(process.argv.includes("--subtitle-browser"))await require("../../tools/subtitle-import-browser-check.js")(address,workId,"srt");
  const third=await candidate(3,actor,"vtt");await approveFixture(third,actor,2);await quiz.loadRemoteContent();assert.equal(quiz.data.book.contentVersion,3);assert.ok(quiz.cuesForBook()[0].text.startsWith("VTT import:"));
  readerPage=page("player");readerPage.data.book={...catalog.get(workId),chapterId:pieceId};readerPage.refresh();await readerPage.loadRemoteContent();assert.equal(readerPage.data.remoteContentStatus,"ready");readerPage.updateSubtitles(0,true);
  assert.ok(readerPage.data.subtitleRows.some((row:any)=>row.text?.includes("VTT import:")));assert.ok(readerPage.data.subtitleRows.every((row:any)=>(row.tokens??[]).every((token:any)=>token.vocabKey===null)));
  if(process.argv.includes("--subtitle-browser"))await require("../../tools/subtitle-import-browser-check.js")(address,workId,"vtt");
  await candidate(4,actor,"srt","overlap");await candidate(5,actor,"srt","duration");await candidate(6,actor,"srt","checksum");
  if(process.argv.includes("--operations-browser"))await candidate(7,actor,"vtt");
  await assert.rejects(client.getManifest(pieceId,1));
  await assert.rejects(renewAudio(leaseBook));
  await ingest.rollbackContentVersion(third,{targetContentVersion:1,reason:"isolated rollback regression"},actor,"rollback-fixture");
  const projection=(await pool.query("SELECT p.word_count,p.ranking_level,w.author,w.series FROM pieces p JOIN works w ON w.id=p.work_id WHERE p.id=$1",[pieceId])).rows[0]!;
  assert.deepEqual(projection,{word_count:952,ranking_level:"4.20",author:"Test Author 1",series:"Test Series 1"});
  await quiz.loadRemoteContent();assert.equal(quiz.data.book.contentVersion,1);assert.equal(quiz.quizPackage.contentVersion,1);
  await pool.query("UPDATE works SET access_type='restricted' WHERE id=$1",[workId]);assert.equal((await client.getWork(workId)).pieces[0].access,"restricted");await assert.rejects(client.getManifest(pieceId,1));
  await assert.rejects(renewAudio(leaseBook));
  await pool.query("UPDATE works SET status='archived' WHERE id=$1",[workId]);assert.equal((await client.listWorks()).items.length,0);await assert.rejects(client.getWork(workId));
  await quiz.loadRemoteContent();assert.equal(quiz.remoteBundle,null);assert.equal(quiz.questions.length,0);
  assert.equal(await rollbackOne(pool,{schema}),"0019_bulk_content_import");assert.equal(await rollbackOne(pool,{schema}),"0018_ingestion_operations");await assert.rejects(rollbackOne(pool,{schema}),/upload recovery facts exist/);assert.ok(downloads.length>=12);
  process.stdout.write("catalog.ingestion.smoke.passed http=real versions=3 timedSubtitles=srt+vtt source=retained derivedDigest=verified inputOver8MiB=streamed invalid=overlap+duration+checksum-blocked realS3=true concurrentItems=7 publishGate=blocked catalog=dynamic bundle=verified audioLease=expired403-renewed206-digestVerified-denialBlocked quiz=server progress=authoritative favorites=cloud words=cloud rollback=aligned archived=hidden\n");
 }finally{
  readerPage?.onUnload();libraryManager.deactivate();wordManager.deactivate();Object.assign(api,savedApi);sync._resetForTests();host.setAccountScope(null);catalog.reset();(globalThis as any).wx=previousWx;
  await app.close();await worker.close();await events.close();await cleanupObjects();await queue.obliterate({force:true});await queue.close();s3.destroy();await pool.end();
  await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();
 }
}
main().catch(error=>{process.stderr.write(String(error instanceof Error?error.stack:error)+"\n");process.exitCode=1});
