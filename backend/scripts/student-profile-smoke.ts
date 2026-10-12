import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import {Ajv2020} from "ajv/dist/2020.js";
import {S3Client} from "@aws-sdk/client-s3";
import pg from "pg";
import {loadConfig} from "../src/config.ts";
import {migrateUp,rollbackOne} from "../src/database/migrator.ts";
import {createApp} from "../src/api/app.ts";
import {SessionService} from "../src/auth/session-service.ts";
import {StubWechatIdentityProvider} from "../src/auth/wechat-provider.ts";
import {StudentProfileService} from "../src/profile/student-profile-service.ts";
import {RankingAggregationService} from "../src/ranking/aggregation-service.ts";
import {RankingRebuildProcessor} from "../src/ranking/rebuild-processor.ts";
import {RankingQueryService,isoWeek,weekWindow} from "../src/ranking/query-service.ts";
import {ProgressSyncService} from "../src/sync/progress-sync-service.ts";
import {SavedWordSyncService} from "../src/sync/saved-word-sync-service.ts";
import {ReaderLibraryService} from "../src/sync/reader-library-service.ts";
import {LearningHistoryService} from "../src/quiz/history-service.ts";
import {ContentService} from "../src/content/service.ts";
import {QuizService} from "../src/quiz/service.ts";

const require=createRequire(import.meta.url),base=loadConfig();
if(!["local","test"].includes(base.appEnv)||!/^postgresql:\/\/[^@]+@127\.0\.0\.1:(15432\/tingyue_test|55433\/tingyue)$/.test(base.databaseUrl))throw Error("Explicit isolated local test database required");
const config=loadConfig({APP_ENV:"test",DATABASE_URL:base.databaseUrl,WECHAT_PROVIDER:"stub"});
const schema="student_profile_"+randomBytes(8).toString("hex");assert.match(schema,/^student_profile_[a-f0-9]{16}$/);
const admin=new pg.Pool({connectionString:config.databaseUrl,max:1});
const pool=new pg.Pool({connectionString:config.databaseUrl,max:10,options:"-c search_path="+schema+",public",application_name:schema});
const sdk=new S3Client({endpoint:"http://127.0.0.1:9000",region:"us-east-1",forcePathStyle:true,credentials:{accessKeyId:config.objectStorage.accessKey,secretAccessKey:config.objectStorage.secretKey}});
const stub=new StubWechatIdentityProvider();
// Fresh one-time codes may resolve to the same test OpenID, like separate real-device logins.
// This alias provider exists only in the explicitly isolated local fixture.
const provider={async exchangeCode(code:string){
 const identity=await stub.exchangeCode(code);
 const alias=({"test:student-profile-browser-operator":"profile-operator-a","test:student-profile-browser-reader":"profile-reader-a"} as Record<string,string>)[code.split("#")[0]!];
 return alias?{openid:"stub-openid-"+alias,unionid:"stub-unionid-"+alias}:identity;
}};
const sessions=new SessionService(pool,provider,config),service=new StudentProfileService(pool,config.auth.dataEncryptionKeyBase64);
const app=createApp({sessionService:sessions,studentProfileService:service,rankingService:new RankingQueryService(pool,config.auth.identityHashKeyBase64),
  progressSyncService:new ProgressSyncService(pool),savedWordSyncService:new SavedWordSyncService(pool,config.auth.identityHashKeyBase64),
  readerLibraryService:new ReaderLibraryService(pool,config.auth.identityHashKeyBase64),learningHistoryService:new LearningHistoryService(pool,config.auth.identityHashKeyBase64),
  contentService:new ContentService(pool,sdk,config.auth.identityHashKeyBase64),quizService:new QuizService(pool)});
const api=require("../../miniprogram/services/api.js"),host=require("../../miniprogram/services/host.js"),savedApi={...api},oldWx=(globalThis as any).wx;
const storage=new Map<string,unknown>(),runtime={login:({success}:any)=>success({code:"test:profile-platform-code"}),getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:unknown)=>storage.set(k,v),
  getAccountInfoSync:()=>({miniProgram:{envVersion:"develop"}}),getWindowInfo:()=>({statusBarHeight:24}),showToast:()=>{}};
(globalThis as any).wx=runtime;
let address="";
const schemaDoc=JSON.parse(await readFile(new URL("../contracts/schemas/api-v1.schema.json",import.meta.url),"utf8"));
const ajv=new Ajv2020({allErrors:true,strict:true});require("ajv-formats")(ajv);ajv.addSchema(schemaDoc);
function validate(name:string,value:unknown){const fn=ajv.getSchema(schemaDoc.$id+"#/$defs/"+name)!;assert.equal(fn(value),true,ajv.errorsText(fn.errors))}
function device(code:string){
 const requests:any[]=[];
 const client=api.createBackendApi({configuration:{enabled:true,apiRoot:address+"/api/v1",contractVersion:"api-contract-v2.5.0",development:true,stubLoginCode:code},runtime,maxRetries:0,
  transport:async(request:any)=>{requests.push({method:request.method,path:new URL(request.url).pathname});const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body)});
    return{statusCode:response.status,data:await response.json(),headers:Object.fromEntries(response.headers)}}});
 return{client,requests};
}
const input=(patch:any={})=>({mutationId:"profile-smoke-"+randomUUID(),baseRevision:"0",campusId:"a",grade:"3",readingLevel:"2",reason:"核对学校档案",...patch});
async function main(){
 await admin.query('CREATE SCHEMA "'+schema+'"');
 try{
  await migrateUp(pool,{schema});address=await app.listen({host:"127.0.0.1",port:0});
  const reader=device("test:profile-reader-a"),other=device("test:profile-reader-b"),operator=device("test:profile-operator-a"),operator2=device("test:profile-operator-b"),contentOnly=device("test:profile-content-only");
  const identities=[];for(const d of [reader,other,operator,operator2,contentOnly])identities.push(await d.client.loginWechat());
  const [learner,second,ops,ops2,contentAdmin]=identities;
  await pool.query("INSERT INTO user_roles(user_id,role,granted_by) VALUES($1,'operations_admin','isolated-fixture'),($2,'operations_admin','isolated-fixture'),($3,'content_admin','isolated-fixture')",[ops.userId,ops2.userId,contentAdmin.userId]);
  const initial=await reader.client.studentProfile();validate("StudentProfileResponse",initial);assert.equal(initial.canManage,false);assert.equal(initial.profile.status,"unassigned");assert.equal(initial.profile.revision,"0");
  const code=initial.profile.studentCode,otherCode=(await other.client.studentProfile()).profile.studentCode;
  assert.notEqual(code,otherCode);assert.doesNotMatch(JSON.stringify(initial),/userId|user_id|openid|phone|email/);
  await assert.rejects(reader.client.findStudentProfile(code),(e:any)=>e.serverCode==="FORBIDDEN");
  await assert.rejects(contentOnly.client.studentProfileOptions(),(e:any)=>e.serverCode==="FORBIDDEN");
  const options=await operator.client.studentProfileOptions();validate("StudentProfileOptionsResponse",options);
  assert.equal(options.cohortPolicy,"period_start");assert.equal(options.grades.length,10);assert.equal(options.readingLevels.length,5);
  const request=input();validate("StudentProfileMutationRequest",request);
  const first=await operator.client.updateStudentProfile(code,request);validate("StudentProfileMutationResponse",first);
  assert.equal(first.profile.revision,"1");assert.equal(first.profile.source,"admin");assert.equal(first.profile.status,"verified");
  const beforeReplay=(await pool.query("SELECT (SELECT count(*) FROM user_profile_versions WHERE user_id=$1)::int AS versions,(SELECT count(*) FROM audit_events WHERE action='student_profile_maintained' AND target_id=$1::text)::int AS audits",[learner.userId])).rows[0];
  const replay=await operator.client.updateStudentProfile(code,request);assert.deepEqual(replay.profile,first.profile);
  assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM user_profile_versions WHERE user_id=$1)::int AS versions,(SELECT count(*) FROM audit_events WHERE action='student_profile_maintained' AND target_id=$1::text)::int AS audits",[learner.userId])).rows[0],beforeReplay);
  await assert.rejects(operator.client.updateStudentProfile(otherCode,request),(e:any)=>e.serverCode==="IDEMPOTENCY_KEY_REUSED");
  const concurrent=await Promise.allSettled([operator.client.updateStudentProfile(code,input({baseRevision:"1",grade:"4"})),operator2.client.updateStudentProfile(code,input({baseRevision:"1",grade:"5"}))]);
  assert.equal(concurrent.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((concurrent.find(r=>r.status==="rejected")as PromiseRejectedResult).reason.serverCode,"CONFLICT");
  assert.equal((await reader.client.studentProfile()).profile.revision,"2");
  await assert.rejects(operator.client.updateStudentProfile(code,input({baseRevision:"0"})),(e:any)=>e.serverCode==="CONFLICT");
  const noChange=(await reader.client.studentProfile()).profile;
  const unchanged=await operator.client.updateStudentProfile(code,input({baseRevision:noChange.revision,campusId:noChange.campusId,grade:noChange.grade,readingLevel:noChange.readingLevel}));
  assert.equal(unchanged.status,"unchanged");assert.equal(unchanged.profile.revision,"2");
  await pool.query("UPDATE campuses SET status='inactive' WHERE id='b'");
  await assert.rejects(operator.client.updateStudentProfile(code,input({baseRevision:"2",campusId:"b"})),(e:any)=>e.serverCode==="INVALID_REQUEST");
  await pool.query("UPDATE campuses SET status='active' WHERE id='b'");
  const blocker=await pool.connect();let revocationRequest:Promise<any>|undefined;
  try{
   await blocker.query("BEGIN");await blocker.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",[learner.userId]);
   revocationRequest=operator.client.updateStudentProfile(code,input({baseRevision:"2"}));
   assert.ok(revocationRequest);void revocationRequest.catch(()=>{});
   // Observe the specific live SQL lock wait; do not race on an arbitrary sleep.
   let waiting=false;
   for(let n=0;n<150&&!waiting;n++){
    waiting=!!(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id,status FROM users%' LIMIT 1",[schema])).rowCount;
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.equal(waiting,true,"profile mutation must be waiting on the locked student");
   await pool.query("DELETE FROM user_roles WHERE user_id=$1 AND role='operations_admin'",[ops.userId]);
   await blocker.query("COMMIT");await assert.rejects(revocationRequest,(e:any)=>e.serverCode==="FORBIDDEN");
  }finally{await blocker.query("ROLLBACK");blocker.release();if(revocationRequest)await revocationRequest.catch(()=>{})}
  assert.equal((await reader.client.studentProfile()).profile.revision,"2");
  await pool.query("INSERT INTO user_roles(user_id,role,granted_by) VALUES($1,'operations_admin','isolated-fixture')",[ops.userId]);
  for(const key of Object.keys(operator.client))if(typeof operator.client[key]==="function"&&key in api)api[key]=operator.client[key];
  host.setAccountScope(ops.userId);
  const page=require("../../miniprogram/ui/controller.js").createPage("student-profile");page.setData=(patch:any)=>Object.assign(page.data,patch);page.onLoad();await page.bootstrap();
  page.typeCode({detail:{value:otherCode}});await page.lookup();page.chooseCampus({detail:{value:1}});page.chooseGrade({detail:{value:5}});page.chooseLevel({detail:{value:2}});page.typeReason({detail:{value:"校方确认"}});page.confirm();await page.save();
  assert.equal(page.data.profile.status,"verified");assert.equal((await other.client.studentProfile()).profile.grade,"4");
  await operator.client.updateStudentProfile(code,input({baseRevision:"2",grade:"3",readingLevel:"2"}));
  // Seed a historical verified fixture only in this random schema; the API never accepts backdating.
  await pool.query("UPDATE user_profile_versions SET effective_from=now()-interval '400 days' WHERE user_id=$1 AND effective_until IS NULL",[learner.userId]);
  const current=(await reader.client.studentProfile()).profile;
  const transferred=await operator.client.updateStudentProfile(code,input({baseRevision:current.revision,campusId:"b",grade:"7",readingLevel:"4"}));
  assert.equal(transferred.profile.campusId,"b");assert.ok(transferred.profile.effectiveFrom);
  await pool.query("INSERT INTO works(id,title,status) VALUES('profile-work','Profile fixture','published')");
  await pool.query("INSERT INTO pieces(id,work_id,title,status,word_count,ranking_level) VALUES('profile-piece','profile-work','Profile fixture','draft',10,1)");
  await pool.query("INSERT INTO learning_score_events(user_id,piece_id,event_key,kind,points,earned_at) VALUES($1,'profile-piece','after-transfer','listening',5,clock_timestamp())",[learner.userId]);
  const calls:any[]=[],aggregation=new RankingAggregationService(pool,config.auth.identityHashKeyBase64);
  const now=new Date();
  const processor=new RankingRebuildProcessor(pool,{build:async(d:any)=>{calls.push(d);return{}as any}}as any,()=>now);
  await processor.processAvailable();assert.ok(calls.length>=4);assert.ok(calls.every(d=>d.campusId==="a"));
  const weekly=calls.find(d=>d.periodType==="week"&&d.grade===null&&d.readingLevel===null);
  const currentRank=await aggregation.compute(weekly);assert.equal(currentRank.entries.find(e=>e.userId===learner.userId)?.score,"5");
  const nextWeekAt=new Date(weekWindow(isoWeek(now).year+"-W"+String(isoWeek(now).week).padStart(2,"0")).endsAt.getTime()+20*3600000);
  await pool.query("INSERT INTO learning_score_events(user_id,piece_id,event_key,kind,points,earned_at) VALUES($1,'profile-piece','next-period','listening',1,$2)",[learner.userId,nextWeekAt]);
  const later:any[]=[],laterProcessor=new RankingRebuildProcessor(pool,{build:async(d:any)=>{later.push(d);return{}as any}}as any,()=>nextWeekAt);
  await laterProcessor.processAvailable();assert.ok(later.some(d=>d.periodType==="week"&&d.campusId==="b"));
  for(const d of later)assert.equal(d.campusId,new Date(d.startsAt)>=new Date(transferred.profile.effectiveFrom)?"b":"a");
  assert.equal((await operator.client.updateStudentProfile(otherCode,input({baseRevision:"1",campusId:null,grade:null,readingLevel:null}))).profile.status,"unassigned");
  const retained=(await pool.query("SELECT count(*)::int AS count FROM user_profile_versions")).rows[0].count;
  assert.equal(await rollbackOne(pool,{schema}),"0019_bulk_content_import");assert.equal(await rollbackOne(pool,{schema}),"0018_ingestion_operations");assert.equal(await rollbackOne(pool,{schema}),"0017_upload_recovery");assert.equal(await rollbackOne(pool,{schema}),"0016_student_profile_management");await migrateUp(pool,{schema});
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM user_profile_versions")).rows[0].count,retained);
  const renewed=await reader.client.studentProfile();assert.notEqual(renewed.profile.studentCode,code);assert.equal(renewed.profile.campusId,"b");assert.equal(renewed.profile.revision,"0");
  await assert.rejects(operator.client.updateStudentProfile(code,request),(e:any)=>e.serverCode==="RESOURCE_NOT_FOUND");
  if(process.argv.includes("--browser")){
   await require("../../tools/student-profile-browser-check.js")(address,renewed.profile.studentCode);
  }
  console.log("student-profile.smoke.passed http=real sessions=actual-local-stub frontend=actual roles=operations-only concurrency=revision idempotency=encrypted revocation=locked periodStart=preserved rollback=facts-preserved");
 }finally{
  Object.assign(api,savedApi);(globalThis as any).wx=oldWx;host.setAccountScope(null);
  await app.close();sdk.destroy();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();
 }
}
main().catch(error=>{console.error(error.stack??error.message);process.exitCode=1});
