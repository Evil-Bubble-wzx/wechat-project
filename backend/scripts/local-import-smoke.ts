import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

import pg from "pg";

import { createApp } from "../src/api/app.ts";
import { SessionService } from "../src/auth/session-service.ts";
import { StubWechatIdentityProvider } from "../src/auth/wechat-provider.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { QuizService } from "../src/quiz/service.ts";
import { LocalImportService } from "../src/sync/local-import-service.ts";

const {Pool}=pg,require=createRequire(import.meta.url);
const schema=`local_import_${randomBytes(8).toString("hex")}`;
if(!/^local_import_[a-f0-9]{16}$/.test(schema))throw new Error("Invalid local import schema");
const base=loadConfig(),config=loadConfig({APP_ENV:"test",DATABASE_URL:base.databaseUrl,WECHAT_PROVIDER:"stub"});
const adminPool=new Pool({connectionString:config.databaseUrl,max:1});
const pool=new Pool({connectionString:config.databaseUrl,max:5,options:`-c search_path=${schema},public`});
type WxRequestOptions={url:string;method?:string;header?:Record<string,string>;data?:unknown;success(response:unknown):void;fail(error:unknown):void};

async function seedContent():Promise<void>{
  await pool.query("INSERT INTO works (id,title,status,access_type) VALUES ('peter-rabbit','Peter Rabbit','published','free')");
  await pool.query("INSERT INTO pieces (id,work_id,title,status,access_type) VALUES ('peter-rabbit-01','peter-rabbit','Peter Rabbit','published','free')");
  const version=await pool.query<{id:string}>("INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ('peter-rabbit-01',1,'published',true,$1,now()) RETURNING id",["a".repeat(64)]);
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='peter-rabbit-01'",[version.rows[0]!.id]);
  await pool.query("INSERT INTO content_assets (piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES ('peter-rabbit-01',1,'audio','test','peter.mp3',$1,1,'audio/mpeg',322026,'published')",["b".repeat(64)]);
  const quiz=await pool.query<{id:string}>("INSERT INTO quiz_packages (piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES ('peter-rabbit-01',1,1,$1,'published',80,now()) RETURNING id",["c".repeat(64)]);
  const quizPackage=require("../../miniprogram/modules/listen-read/peter-quiz-data.js") as {questions:Array<{id:string;q:string;options:string[];answer:number}>};
  for(const [index,question] of quizPackage.questions.entries())await pool.query("INSERT INTO quiz_questions (quiz_package_id,question_id,prompt,options,correct_option,sort_order) VALUES ($1,$2,$3,$4,$5,$6)",[quiz.rows[0]!.id,question.id,question.q,JSON.stringify(question.options),question.answer,index]);
}

async function main():Promise<void>{
  await adminPool.query(`CREATE SCHEMA "${schema}"`);let app:ReturnType<typeof createApp>|undefined;
  try{
    await migrateUp(pool,{schema});await seedContent();
    const sessions=new SessionService(pool,new StubWechatIdentityProvider(),config),quiz=new QuizService(pool);
    app=createApp({appEnv:"test",sessionService:sessions,quizService:quiz,localImportService:new LocalImportService(pool,quiz)});
    const address=await app.listen({host:"127.0.0.1",port:0}),storage=new Map<string,unknown>();storage.set("tingyue.dev.apiBaseUrl",address);
    const wx={isBrowserPreview:false,getAccountInfoSync:()=>({miniProgram:{envVersion:"develop"}}),getExtConfigSync:()=>({}),getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value),removeStorageSync:(key:string)=>storage.delete(key),login:({success}:{success(value:{code:string}):void})=>success({code:"local-import-user"}),request:(options:WxRequestOptions)=>{void(async()=>{try{const response=await fetch(options.url,{method:options.method??"GET",headers:options.header,body:options.data===undefined?undefined:JSON.stringify(options.data)});const body=await response.text();options.success({statusCode:response.status,data:body?JSON.parse(body):null,header:Object.fromEntries(response.headers.entries())})}catch(error){options.fail(error)}})()}};
    (globalThis as unknown as {wx:typeof wx}).wx=wx;
    assert.equal((await fetch(`${address}/api/v1/me/local-import`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
    const api=require("../../miniprogram/services/api.js") as {loginWechat():Promise<{userId:string}>;localImport(request:unknown):Promise<any>};
    const me=await api.loginWechat();
    const localImport=require("../../miniprogram/modules/sync/local-import.js") as {prepareLocalImport(state:unknown):any};
    const quizPackage=require("../../miniprogram/modules/listen-read/peter-quiz-data.js") as {questions:Array<{id:string;answer:number}>};
    const plan=localImport.prepareLocalImport({progress:{"peter-rabbit-01":{seconds:40,checkpointSeconds:21.235,completed:true,duration:322.026,listenedRanges:[[0,20],[321,322.026]],listenedSeconds:999,coverage:1,completionReason:"client-only",contentVersion:1,audioKey:"private",schemaVersion:2,updatedAt:"2026-09-28T08:00:00.000Z"}},words:["Once","upon"],results:[{schemaVersion:1,attemptId:"local-import-attempt-01",workId:"peter-rabbit",pieceId:"peter-rabbit-01",contentVersion:1,quizVersion:1,questionIds:quizPackage.questions.map(question=>question.id),selectedOptions:quizPackage.questions.map(question=>question.answer),startedAt:"2026-09-28T07:55:00.000Z",submittedAt:"2026-09-28T08:00:00.000Z",status:"local_unverified",score:0,mastery:false,title:"must stay local"}]});
    assert.equal(plan.ready,true);assert.equal(JSON.stringify(plan.payload).includes("client-only"),false);
    const request={snapshotId:plan.snapshotId,payload:plan.payload,limitations:plan.limitations};
    const first=await api.localImport(request);assert.equal(first.duplicate,false);assert.deepEqual(first.summary,{progress:{accepted:1,unchanged:0,rejected:0},words:{pending:2,reused:0,rejected:0},quizAttempts:{verified:1,rejected:0}});assert.equal(first.items.progress[0].completed,false);assert.equal(first.items.quizAttempts[0].score,100);
    const repeated=await api.localImport(request);assert.equal(repeated.duplicate,true);assert.equal(repeated.acknowledgedAt,first.acknowledgedAt);
    const stored=await pool.query<{progress:string;words:string;attempts:string;events:string;completed:boolean;coverage:string}>(`SELECT (SELECT count(*)::text FROM user_learning_progress WHERE user_id=$1) progress,(SELECT count(*)::text FROM user_saved_word_candidates WHERE user_id=$1) words,(SELECT count(*)::text FROM quiz_attempts WHERE user_id=$1) attempts,(SELECT count(*)::text FROM ranking_rebuild_events) events,(SELECT completed FROM user_learning_progress WHERE user_id=$1 AND piece_id='peter-rabbit-01') completed,(SELECT coverage::text FROM user_learning_progress WHERE user_id=$1 AND piece_id='peter-rabbit-01') coverage`,[me.userId]);
    assert.deepEqual({progress:stored.rows[0]!.progress,words:stored.rows[0]!.words,attempts:stored.rows[0]!.attempts,events:stored.rows[0]!.events,completed:stored.rows[0]!.completed},{progress:"1",words:"2",attempts:"1",events:"1",completed:false});assert.ok(Number(stored.rows[0]!.coverage)<0.1,"server must ignore client completion and recompute coverage");
    process.stdout.write(`local-import.smoke.passed schema=${schema} progress=recomputed words=pending quiz=verified idempotent=replayed\n`);
  }finally{if(app)await app.close();await pool.end();await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);await adminPool.end();delete(globalThis as {wx?:unknown}).wx}
}
main().catch((error:unknown)=>{process.stderr.write(`${error instanceof Error?error.stack??error.message:String(error)}\n`);process.exitCode=1});
