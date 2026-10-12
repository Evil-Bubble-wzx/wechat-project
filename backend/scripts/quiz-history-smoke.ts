import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import {Ajv2020} from "ajv/dist/2020.js";
import pg from "pg";
import {loadConfig} from "../src/config.ts";
import {migrateUp,rollbackOne} from "../src/database/migrator.ts";
import {createApp} from "../src/api/app.ts";
import {SessionService} from "../src/auth/session-service.ts";
import {StubWechatIdentityProvider} from "../src/auth/wechat-provider.ts";
import {QuizService} from "../src/quiz/service.ts";
import {LearningHistoryService} from "../src/quiz/history-service.ts";
import {ProgressSyncService} from "../src/sync/progress-sync-service.ts";
const schema="quiz_history_"+randomBytes(8).toString("hex");
if(!/^quiz_history_[a-f0-9]{16}$/.test(schema))throw new Error("Invalid isolated schema");
const base=loadConfig();
if(base.databaseUrl!=="postgresql://tingyue:tingyue-local@127.0.0.1:15432/tingyue_test")throw new Error("Quiz history smoke is restricted to the existing local test database");
const config=loadConfig({APP_ENV:"test",DATABASE_URL:base.databaseUrl,WECHAT_PROVIDER:"stub"});
const {Pool}=pg,admin=new Pool({connectionString:config.databaseUrl,max:1});
const pool=new Pool({connectionString:config.databaseUrl,max:8,options:"-c search_path="+schema+",public",statement_timeout:15000});
const require=createRequire(import.meta.url),addFormats=require("ajv-formats");
const document=JSON.parse(await readFile(new URL("../contracts/schemas/api-v1.schema.json",import.meta.url),"utf8"));
const ajv=new Ajv2020({allErrors:true,strict:true});addFormats(ajv);ajv.addSchema(document);
const validateHistory=ajv.getSchema(document.$id+"#/$defs/QuizHistoryResponse")!;
const validateSummary=ajv.getSchema(document.$id+"#/$defs/LearningSummary")!;
let address="";
const {createBackendApi}=require("../../miniprogram/services/api.js");
const {createQuizSyncManager}=require("../../miniprogram/modules/sync/quiz-sync.js");
const {view:reportView}=require("../../miniprogram/modules/report/cloud-view.js");
function attempt(index:number,id:string,answers=[0,1]){
  // Client clocks intentionally differ; report ordering must use verified_at.
  const at=index===1?"2999-01-01T00:00:00.000Z":"2000-01-01T00:00:00.000Z";
  return {schemaVersion:1 as const,attemptId:id,workId:"history-book",pieceId:"history-piece-"+index,contentVersion:1,quizVersion:1,
    questionIds:["q"+index+"-1","q"+index+"-2"],selectedOptions:answers,startedAt:at,submittedAt:at,
    status:"local_unverified",score:100,mastery:true,title:"Piece "+index};
}
async function seed(){
  await pool.query("INSERT INTO works(id,title,status) VALUES('history-book','History Book','published')");
  for(let i=1;i<=7;i++){
    const piece="history-piece-"+i;
    await pool.query("INSERT INTO pieces(id,work_id,title,sort_order,status,word_count) VALUES($1,'history-book',$2,$3,'published',101)",[piece,"Piece "+i,i]);
    const version=(await pool.query("INSERT INTO content_versions(piece_id,content_version,status,publishable,manifest_sha256,published_at,catalog_metadata) VALUES($1,1,'published',true,$2,now(),$3) RETURNING id",[piece,"a".repeat(64),JSON.stringify({wordCount:i===7?null:101})])).rows[0].id;
    await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id=$2",[version,piece]);
    await pool.query("INSERT INTO content_assets(piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES($1,1,'audio','test',$2,$3,1,'audio/mpeg',10000,'published')",[piece,piece+".mp3","b".repeat(64)]);
    const pkg=(await pool.query("INSERT INTO quiz_packages(piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES($1,1,1,$2,'published',80,now()) RETURNING id",[piece,"c".repeat(64)])).rows[0].id;
    for(let q=1;q<=2;q++)await pool.query("INSERT INTO quiz_questions(quiz_package_id,question_id,prompt,options,correct_option,sort_order) VALUES($1,$2,'Question','[\"A\",\"B\"]',$3,$4)",[pkg,"q"+i+"-"+q,q-1,q-1]);
  }
}
async function device(code="test:quiz-history-main-a"){
  const storage=new Map<string,unknown>();let state:Record<string,any>={results:[]};
  const api=createBackendApi({configuration:{enabled:true,apiRoot:address+"/api/v1",contractVersion:"api-contract-v2.3.0",development:true,stubLoginCode:code},
    runtime:{login:({success}:any)=>success({code:"stub-platform-code"}),getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value)},
    maxRetries:0,transport:async(request:any)=>{
      const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body),signal:AbortSignal.timeout(20000)});
      const data=await response.json();
      if(response.ok&&request.url.includes("/quiz-history"))assert.equal(validateHistory(data),true,ajv.errorsText(validateHistory.errors));
      if(response.ok&&request.url.includes("/learning-summary"))assert.equal(validateSummary(data),true,ajv.errorsText(validateSummary.errors));
      return {statusCode:response.status,data,header:Object.fromEntries(response.headers)};
    }});
  const user=await api.loginWechat();
  const host={accountScope:()=>user.userId,read:()=>state,mutate:(fn:any)=>{state=fn(state);return state}};
  const manager=createQuizSyncManager({api,host,runtime:{getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value)},schedule:()=>0,cancel:()=>{}});
  manager.activate(user.userId,{sync:false});return {api,host,manager,user,storage};
}
async function main(){
  await admin.query('CREATE SCHEMA "'+schema+'"');
  let app:ReturnType<typeof createApp>|undefined;
  const managers:any[]=[];
  try{
    await migrateUp(pool,{schema});await seed();
    const history=new LearningHistoryService(pool,config.auth.identityHashKeyBase64);
    const oneTimeCodes=new StubWechatIdentityProvider();
    const provider={async exchangeCode(code:string){
      const identity=await oneTimeCodes.exchangeCode(code);
      // Two unique one-time platform codes may identify the same test reader.
      return /^test:quiz-history-main-[ab]$/.test(code)?{openid:"stub-openid-quiz-history-main",unionid:"stub-unionid-quiz-history-main"}:identity;
    }};
    app=createApp({appEnv:"test",sessionService:new SessionService(pool,provider,config),quizService:new QuizService(pool),learningHistoryService:history,progressSyncService:new ProgressSyncService(pool)});
    address=await app.listen({host:"127.0.0.1",port:0});
    assert.equal((await fetch(address+"/api/v1/me/quiz-history")).status,401);
    const first=await device(),second=await device("test:quiz-history-main-b"),other=await device("test:quiz-history-other");
    managers.push(first.manager,second.manager,other.manager);
    assert.equal(first.user.userId,second.user.userId);assert.notEqual(first.user.userId,other.user.userId);
    assert.equal(first.api.quizHistoryAvailable(),true);
    const empty=await first.api.learningSummary();assert.equal(empty.averageCorrectPercent,null);assert.equal(empty.completedWords,"0");
    // A durable offline attempt uses the same actual frontend API when retried.
    const send=first.api.submitQuiz;let offline=true;
    first.api.submitQuiz=async(value:any)=>{if(offline)throw Object.assign(new Error("offline"),{retryable:true});return send(value)};
    const local=attempt(1,"quiz-history-offline",[1,0]);first.host.mutate((s:any)=>({...s,results:[local],words:["keep"]}));
    first.manager.enqueue(local,false);assert.equal(await first.manager.trigger("offline",true),false);
    assert.equal(first.manager.status().pendingCount,1);offline=false;
    assert.equal(await first.manager.trigger("retry",true),true);assert.equal(first.manager.status().pendingCount,0);
    assert.equal(first.host.read().results[0].score,0);assert.deepEqual(first.host.read().words,["keep"]);
    for(let i=2;i<=6;i++)await first.api.submitQuiz(attempt(i,"quiz-history-piece-"+i,i===2?[0,0]:[0,1]));
    assert.equal(await second.manager.trigger("other-device",true),true);
    const initial=second.host.read().cloudLearningSummary;
    assert.equal(initial.verifiedAttemptCount,6);assert.equal(initial.compatibleQuizPieces,6);assert.equal(initial.averageCorrectPercent,75);
    assert.deepEqual(initial.trend,{ready:true,remaining:0,early:25,recent:100,delta:75,pieceCount:6});
    const held=await pool.connect();
    try{
      await held.query("BEGIN");
      const began=(await held.query("SELECT transaction_timestamp() AS at")).rows[0].at;
      await held.query("SELECT pg_sleep(0.02)");
      const accepted=await new QuizService(pool).submit(first.user.userId,attempt(2,"history-clock-rollback"),held);
      assert.equal(accepted.status,"server_verified");
      if(accepted.status==="server_verified")assert.ok(Date.parse(accepted.verifiedAt)-began.getTime()>=10,"verification time is after waiting, not transaction BEGIN");
      await held.query("ROLLBACK");
    }finally{await held.query("ROLLBACK");held.release()}
    assert.equal(second.host.read().cloudQuizHistory.length,6);
    const page1=await first.api.quizHistory(null,2);assert.equal(page1.hasMore,true);assert.equal(page1.changes.length,2);
    const page2=await first.api.quizHistory(page1.nextCursor,2);assert.equal(page2.changes.length,2);
    assert.ok(page2.changes.every((e:any)=>!page1.changes.some((p:any)=>p.attemptId===e.attemptId)));
    await assert.rejects(other.api.quizHistory(page1.nextCursor,2),(error:any)=>error.serverCode==="INVALID_REQUEST");
    assert.deepEqual((await other.api.quizHistory(null,100)).changes,[]);
    const improved=attempt(1,"quiz-history-improved");await first.api.submitQuiz(improved);
    assert.equal((await first.api.learningSummary()).averageCorrectPercent,92,"latest is server acceptance, not future client time");
    // Retries and repeated Quiz attempts do not multiply logical question credit.
    await first.api.submitQuiz(improved);assert.equal((await first.api.learningSummary()).verifiedAttemptCount,7);
    const progress=(pieceId:string,version:number,id:string)=>first.api.putProgress(pieceId,{schemaVersion:1,mutationId:id,baseRevision:"0",contentVersion:version,checkpointMs:10000,listenedRangesMs:[[0,10000]]});
    await progress("history-piece-1",1,"history-progress-v1");
    const completed=await first.api.learningSummary();assert.equal(completed.completedPieces,1);assert.equal(completed.completedWords,"101");assert.equal(completed.listenedMs,"10000");
    const version2=(await pool.query("INSERT INTO content_versions(piece_id,content_version,status,publishable,manifest_sha256,published_at,catalog_metadata) VALUES('history-piece-1',2,'published',true,$1,now(),'{\"wordCount\":999}') RETURNING id",["d".repeat(64)])).rows[0].id;
    await pool.query("UPDATE content_versions SET status='superseded' WHERE piece_id='history-piece-1' AND content_version=1");
    await pool.query("UPDATE pieces SET current_content_version_id=$1,word_count=999 WHERE id='history-piece-1'",[version2]);
    await pool.query("INSERT INTO content_assets(piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES('history-piece-1',2,'audio','test','v2.mp3',$1,1,'audio/mpeg',10000,'published')",["e".repeat(64)]);
    await progress("history-piece-1",2,"history-progress-v2");
    const newVersion=await first.api.learningSummary();
    assert.equal(newVersion.completedPieces,1);assert.equal(newVersion.completedWords,"101","words use first completion version, not current catalog");
    assert.equal(newVersion.listenedMs,"10000","versions do not double effective listening");assert.equal(newVersion.compatibleQuizPieces,5);
    const unavailable=await first.api.submitQuiz(attempt(1,"quiz-history-old-new"));assert.equal(unavailable.status,"rejected");assert.equal(unavailable.error.code,"CONTENT_VERSION_UNAVAILABLE");
    await progress("history-piece-7",1,"history-progress-unknown");
    const unknown=await first.api.learningSummary();assert.equal(unknown.completedWords,null);assert.equal(unknown.knownCompletedWords,"101");assert.equal(unknown.unknownWordPieces,1);
    await second.manager.trigger("before-withdrawal",true);
    const cursor=second.manager._inspect().cursor;
    await pool.query("UPDATE quiz_attempts SET withdrawn_at=now(),withdrawal_reason='isolated smoke test' WHERE user_id=$1 AND attempt_id='quiz-history-piece-2'",[first.user.userId]);
    const delta=await first.api.quizHistory(cursor,100);assert.equal(delta.changes.length,1);assert.equal(delta.changes[0].status,"withdrawn");assert.equal(delta.changes[0].score,null);
    const withdrawnReplay=await first.api.submitQuiz(attempt(2,"quiz-history-piece-2",[0,0]));assert.equal(withdrawnReplay.status,"rejected","replay cannot re-validate withdrawn credit");
    await second.manager.trigger("withdrawal",true);
    assert.equal(reportView(second.host.read()).results.find((e:any)=>e.attemptId==="quiz-history-piece-2").scoreLabel,"—");
    assert.equal(second.host.read().cloudLearningSummary.compatibleQuizPieces,4);
    assert.equal(second.host.read().cloudLearningSummary.trend.ready,false);
    // Cursor ordering remains numeric when revisions cross one-digit boundaries.
    await pool.query("SELECT setval('quiz_history_change_seq',99)");
    const after99=attempt(3,"quiz-history-revision-100");await first.api.submitQuiz(after99);
    const full=await first.api.quizHistory(null,100);assert.ok(full.changes.at(-1).revision==="100");
    await pool.query("UPDATE pieces SET status='archived' WHERE id='history-piece-3'");
    assert.equal((await first.api.submitQuiz(attempt(3,"quiz-history-archived"))).status,"rejected");
    await pool.query("UPDATE pieces SET status='published',access_type='restricted' WHERE id='history-piece-3'");
    assert.equal((await first.api.submitQuiz(attempt(3,"quiz-history-restricted"))).status,"rejected");
    await pool.query("UPDATE pieces SET access_type='free' WHERE id='history-piece-3'");
    const newer=(await pool.query("INSERT INTO quiz_packages(piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES('history-piece-6',1,2,$1,'published',80,now()) RETURNING id",["f".repeat(64)])).rows[0].id;
    await pool.query("INSERT INTO quiz_questions(quiz_package_id,question_id,prompt,options,correct_option,sort_order) SELECT $1,question_id,prompt,options,correct_option,sort_order FROM quiz_questions WHERE quiz_package_id=(SELECT id FROM quiz_packages WHERE piece_id='history-piece-6' AND content_version=1 AND quiz_version=1)",[newer]);
    const oldQuiz=await first.api.submitQuiz(attempt(6,"quiz-history-old-quiz"));
    assert.equal(oldQuiz.status,"rejected");assert.equal(oldQuiz.error.code,"QUIZ_PACKAGE_MISMATCH");
    await second.manager.trigger("before-epoch",true);
    const old=second.manager._inspect().cursor;
    assert.equal(await rollbackOne(pool,{schema}),"0015_ranking_quiz_analysis");
    assert.equal(await rollbackOne(pool,{schema}),"0014_quiz_history");await migrateUp(pool,{schema});
    await assert.rejects(first.api.quizHistory(old,100),(error:any)=>error.serverCode==="INVALID_REQUEST");
    assert.equal(await second.manager.trigger("new-epoch",true),true,"actual API error triggers atomic full repull");
    assert.equal(second.host.read().cloudQuizHistory.length,8);assert.equal((await pool.query("SELECT count(*)::int AS n FROM quiz_answers")).rows[0].n,16);
    process.stdout.write("quiz-history.smoke.passed http=real auth=local-stub frontend-api=actual devices=2 offline=immutable pagination=complete withdrawal=propagated replay=revoked reports=trusted versions=deduped words=historical-null clocks=server cursor=account-epoch rollback=facts-preserved\n");
  }finally{
    for(const manager of managers)manager.deactivate();
    if(app)await app.close();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();
  }
}
main().catch(error=>{process.stderr.write(String(error.stack??error)+"\n");process.exitCode=1});
