import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

import pg from "pg";

import { createApp } from "../src/api/app.ts";
import { SessionService } from "../src/auth/session-service.ts";
import { StubWechatIdentityProvider } from "../src/auth/wechat-provider.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { ProgressSyncService } from "../src/sync/progress-sync-service.ts";

const {Pool}=pg,require=createRequire(import.meta.url),schema=`progress_sync_${randomBytes(8).toString("hex")}`;
if(!/^progress_sync_[a-f0-9]{16}$/.test(schema))throw new Error("Invalid progress sync schema");
const base=loadConfig(),config=loadConfig({APP_ENV:"test",DATABASE_URL:base.databaseUrl,WECHAT_PROVIDER:"stub"});
const adminPool=new Pool({connectionString:config.databaseUrl,max:1}),pool=new Pool({connectionString:config.databaseUrl,max:5,options:`-c search_path=${schema},public`});
type WxRequestOptions={url:string;method?:string;header?:Record<string,string>;data?:unknown;success(response:unknown):void;fail(error:unknown):void};

async function seed():Promise<void>{
  await pool.query("INSERT INTO works (id,title,status,access_type) VALUES ('peter-rabbit','Peter Rabbit','published','free')");
  await pool.query("INSERT INTO pieces (id,work_id,title,status,access_type) VALUES ('peter-rabbit-01','peter-rabbit','Peter Rabbit','published','free')");
  const version=await pool.query<{id:string}>("INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ('peter-rabbit-01',1,'published',true,$1,now()) RETURNING id",["a".repeat(64)]);
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='peter-rabbit-01'",[version.rows[0]!.id]);
  await pool.query("INSERT INTO content_assets (piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES ('peter-rabbit-01',1,'audio','test','peter-v1.mp3',$1,1,'audio/mpeg',322026,'published')",["b".repeat(64)]);
}

async function main():Promise<void>{
  await adminPool.query(`CREATE SCHEMA "${schema}"`);let app:ReturnType<typeof createApp>|undefined;
  try{
    await migrateUp(pool,{schema});await seed();
    const sessions=new SessionService(pool,new StubWechatIdentityProvider(),config);
    app=createApp({appEnv:"test",sessionService:sessions,progressSyncService:new ProgressSyncService(pool)});
    const address=await app.listen({host:"127.0.0.1",port:0}),storage=new Map<string,unknown>();storage.set("tingyue.dev.apiBaseUrl",address);
    const wx={isBrowserPreview:false,getAccountInfoSync:()=>({miniProgram:{envVersion:"develop"}}),getExtConfigSync:()=>({}),getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value),login:({success}:{success(value:{code:string}):void})=>success({code:"progress-sync-user"}),request:(options:WxRequestOptions)=>{void(async()=>{try{const response=await fetch(options.url,{method:options.method??"GET",headers:options.header,body:options.data===undefined?undefined:JSON.stringify(options.data)});const body=await response.text();options.success({statusCode:response.status,data:body?JSON.parse(body):null,header:Object.fromEntries(response.headers.entries())})}catch(error){options.fail(error)}})()}};
    (globalThis as unknown as {wx:typeof wx}).wx=wx;
    const api=require("../../miniprogram/services/api.js") as {loginWechat():Promise<{userId:string}>;getProgress(pieceId:string):Promise<any>;putProgress(pieceId:string,request:unknown):Promise<any>;listProgress(cursor:null,limit:number):Promise<any>};
    const me=await api.loginWechat(),empty=await api.getProgress("peter-rabbit-01");assert.equal(empty.progress.revision,"0");
    const firstRequest={schemaVersion:1,mutationId:"progress-smoke-0001",baseRevision:"0",contentVersion:1,checkpointMs:6000,listenedRangesMs:[[0,6000]]};
    const first=await api.putProgress("peter-rabbit-01",firstRequest);assert.equal(first.progress.revision,"1");assert.equal(first.checkpointAccepted,true);
    const replay=await api.putProgress("peter-rabbit-01",firstRequest);assert.equal(replay.duplicate,true);assert.equal(replay.acknowledgedAt,first.acknowledgedAt);
    const stale=await api.putProgress("peter-rabbit-01",{schemaVersion:1,mutationId:"progress-smoke-0002",baseRevision:"0",contentVersion:1,checkpointMs:15000,listenedRangesMs:[[10000,15000]]});
    assert.equal(stale.mergeStatus,"merged_stale_base");assert.equal(stale.progress.checkpointMs,6000);assert.deepEqual(stale.progress.listenedRangesMs,[[0,6000],[10000,15000]]);
    const current=await api.putProgress("peter-rabbit-01",{schemaVersion:1,mutationId:"progress-smoke-0003",baseRevision:stale.progress.revision,contentVersion:1,checkpointMs:15000,listenedRangesMs:[[0,6000],[10000,15000]]});
    assert.equal(current.progress.checkpointMs,15000);assert.equal(current.progress.revision,"3");
    const page=await api.listProgress(null,50);assert.equal(page.items.length,1);assert.equal(page.items[0].revision,"3");
    const rows=await pool.query<{revision:string;mutations:string}>("SELECT revision::text,(SELECT count(*)::text FROM progress_sync_mutations WHERE user_id=$1) mutations FROM user_learning_progress WHERE user_id=$1 AND piece_id='peter-rabbit-01' AND content_version=1",[me.userId]);assert.deepEqual(rows.rows[0],{revision:"3",mutations:"3"});
    process.stdout.write(`progress-sync.smoke.passed schema=${schema} revision=3 stale=range-only idempotent=replayed\n`);
  }finally{if(app)await app.close();await pool.end();await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);await adminPool.end();delete(globalThis as {wx?:unknown}).wx}
}
main().catch((error:unknown)=>{process.stderr.write(`${error instanceof Error?error.stack??error.message:String(error)}\n`);process.exitCode=1});
