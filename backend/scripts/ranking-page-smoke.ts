import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { seedCorrectAnswer } from "./learning-points-fixtures.ts";

import { createApp } from "../src/api/app.ts";
import { SessionService } from "../src/auth/session-service.ts";
import { StubWechatIdentityProvider } from "../src/auth/wechat-provider.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { RankingAggregationService } from "../src/ranking/aggregation-service.ts";
import { RankingQueryService } from "../src/ranking/query-service.ts";

const { Pool } = pg;
const schema = `ranking_page_${randomBytes(8).toString("hex")}`;
if (!/^ranking_page_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid ranking-page schema");
const baseConfig = loadConfig();
const config = loadConfig({ APP_ENV:"test", DATABASE_URL:baseConfig.databaseUrl, WECHAT_PROVIDER:"stub" });
const adminPool = new Pool({ connectionString:config.databaseUrl, max:1 });
const pool = new Pool({ connectionString:config.databaseUrl, max:6, options:`-c search_path=${schema},public` });

type WxRequestOptions = {url:string;method?:string;header?:Record<string,string>;data?:unknown;success(response:unknown):void;fail(error:unknown):void};

async function seedBook():Promise<{packageId:string}> {
  await pool.query("INSERT INTO works (id,title,author,series,ranking_category,status) VALUES ('ranking-page-work','Ranking Page Story','Test Author','Test Series','fiction','published')");
  await pool.query("INSERT INTO pieces (id,work_id,title,status,word_count,ranking_level) VALUES ('ranking-page-piece','ranking-page-work','Ranking Page Story','published',1200,3.2)");
  const version=await pool.query<{id:string}>(`INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ('ranking-page-piece',1,'published',true,$1,now()) RETURNING id`,["a".repeat(64)]);
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='ranking-page-piece'",[version.rows[0]!.id]);
  const quiz=await pool.query<{id:string}>(`INSERT INTO quiz_packages (piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES ('ranking-page-piece',1,1,$1,'published',80,now()) RETURNING id`,["b".repeat(64)]);
  return {packageId:quiz.rows[0]!.id};
}

async function addAttempt(userId:string,packageId:string,label:string,score:number,submittedAt:Date):Promise<void> {
  const id=randomUUID();
  await pool.query(`INSERT INTO quiz_attempts (id,user_id,attempt_id,quiz_package_id,started_at,submitted_at,status,score,mastery,request_hash,verified_at) VALUES ($1,$2,$3,$4,$5,$6,'server_verified',$7,$8,$9,$6)`,[id,userId,label,packageId,new Date(submittedAt.getTime()-60_000),submittedAt,score,score>=80,"c".repeat(64)]);
  await seedCorrectAnswer(pool,id,packageId);
}

async function main():Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  let app:ReturnType<typeof createApp>|undefined;
  try {
    await migrateUp(pool,{schema});
    const book=await seedBook();
    const sessionService=new SessionService(pool,new StubWechatIdentityProvider(),config);
    const rankingQuery=new RankingQueryService(pool,config.auth.identityHashKeyBase64);
    app=createApp({appEnv:"test",sessionService,rankingService:rankingQuery});
    const address=await app.listen({host:"127.0.0.1",port:0});
    const storage=new Map<string,unknown>();
    storage.set("tingyue.dev.apiBaseUrl",address);
    const wx={
      isBrowserPreview:false,
      getAccountInfoSync:()=>({miniProgram:{envVersion:"develop"}}),
      getExtConfigSync:()=>({}),
      getStorageSync:(key:string)=>storage.get(key),
      setStorageSync:(key:string,value:unknown)=>storage.set(key,value),
      removeStorageSync:(key:string)=>storage.delete(key),
      getWindowInfo:()=>({statusBarHeight:24}),
      showToast:()=>{},navigateTo:()=>{},redirectTo:()=>{},navigateBack:()=>{},
      login:({success}:{success(value:{code:string}):void})=>success({code:"ranking-page-user"}),
      request:(options:WxRequestOptions)=>{void (async()=>{try{const response=await fetch(options.url,{method:options.method??"GET",headers:options.header,body:options.data===undefined?undefined:JSON.stringify(options.data)});const body=await response.text();options.success({statusCode:response.status,data:body?JSON.parse(body):null,header:Object.fromEntries(response.headers.entries())})}catch(error){options.fail(error)}})()},
    };
    (globalThis as unknown as {wx:typeof wx}).wx=wx;
    const require=createRequire(import.meta.url);
    const miniappApi=require("../../miniprogram/services/api.js") as {
      loginWechat():Promise<{userId:string}>;rankingOptions():Promise<{periods:{week:Array<{key:string;startsAt:string;endsAt:string}>;month:Array<{key:string;startsAt:string;endsAt:string}>}}>;
      rankings(filters:Record<string,unknown>):Promise<{status:string;items:Array<{participantId:string}>;currentUser:{participantId:string}|null;nextCursor:string|null}>;
      rankingDetail(id:string,filters:Record<string,unknown>):Promise<{quizzes:unknown[];nextCursor:string|null}>;
    };
    const unauth=await fetch(`${address}/api/v1/ranking-options`);
    assert.equal(unauth.status,401,"ranking options must require authentication");
    const me=await miniappApi.loginWechat();
    const participantIds=[me.userId,...Array.from({length:54},()=>randomUUID())];
    for(let index=1;index<participantIds.length;index+=1)await pool.query("INSERT INTO users (id) VALUES ($1)",[participantIds[index]]);
    for(const [index,userId] of participantIds.entries()){
      await pool.query(`INSERT INTO user_profiles (user_id,campus_id,grade,reading_level,profile_source,source_verified_at) VALUES ($1,'a','3','3','admin',now())`,[userId]);
      await pool.query("UPDATE user_profile_versions SET effective_from=now()-interval '40 days' WHERE user_id=$1",[userId]);
      await addAttempt(userId,book.packageId,`ranking-page-${index}-base`,60+(index%41),new Date(Date.now()-120_000));
    }
    for(let index=0;index<51;index+=1)await addAttempt(me.userId,book.packageId,`ranking-page-me-${index}`,70+(index%31),new Date(Date.now()-(index+2)*60_000));
    const smallUser=randomUUID();
    await pool.query("INSERT INTO users (id) VALUES ($1)",[smallUser]);
    await pool.query(`INSERT INTO user_profiles (user_id,campus_id,grade,reading_level,profile_source,source_verified_at) VALUES ($1,'b','3','3','admin',now())`,[smallUser]);
    await pool.query("UPDATE user_profile_versions SET effective_from=now()-interval '40 days' WHERE user_id=$1",[smallUser]);
    await addAttempt(smallUser,book.packageId,"ranking-page-small",90,new Date(Date.now()-120_000));

    const options=await miniappApi.rankingOptions();
    const aggregation=new RankingAggregationService(pool,config.auth.identityHashKeyBase64);
    const now=new Date(),rollingStart=new Date(now.getTime()-7*86_400_000);
    await aggregation.build({periodType:"rolling7",periodKey:"ranking-page-rolling",startsAt:rollingStart.toISOString(),endsAt:new Date(now.getTime()+60_000).toISOString(),campusId:"a",grade:null,readingLevel:null,requestId:"ranking-page-rolling"});
    await aggregation.build({periodType:"rolling7",periodKey:"ranking-page-small",startsAt:rollingStart.toISOString(),endsAt:new Date(now.getTime()+60_000).toISOString(),campusId:"b",grade:null,readingLevel:null,requestId:"ranking-page-small"});
    for(const [type,period] of [["week",options.periods.week[0]!],["month",options.periods.month[0]!]] as const){
      await aggregation.build({periodType:type,periodKey:period.key,startsAt:period.startsAt,endsAt:period.endsAt,campusId:"a",grade:null,readingLevel:null,requestId:`ranking-page-${type}`});
    }

    const first=await miniappApi.rankings({campusId:"a",periodType:"rolling7",grade:"all",level:"all",limit:50});
    assert.equal(first.status,"ready");assert.equal(first.items.length,50);assert.ok(first.nextCursor);assert.ok(first.currentUser);
    const second=await miniappApi.rankings({campusId:"a",periodType:"rolling7",grade:"all",level:"all",cursor:first.nextCursor,limit:50});
    assert.equal(second.items.length,5);assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.items,...second.items].map(item=>item.participantId)).size,55,"ranking pages must not overlap");
    const detail1=await miniappApi.rankingDetail(first.currentUser!.participantId,{campusId:"a",periodType:"rolling7",grade:"all",level:"all",limit:50});
    assert.equal(detail1.quizzes.length,50);assert.ok(detail1.nextCursor);
    const detail2=await miniappApi.rankingDetail(first.currentUser!.participantId,{campusId:"a",periodType:"rolling7",grade:"all",level:"all",cursor:detail1.nextCursor,limit:50});
    assert.equal(detail2.quizzes.length,2);assert.equal(detail2.nextCursor,null);
    assert.doesNotMatch(JSON.stringify(detail1),/selectedOptions|phone|openid/i,"detail must not expose answers or identity fields");
    const small=await miniappApi.rankings({campusId:"b",periodType:"rolling7",grade:"all",level:"all",limit:50});
    assert.equal(small.status,"cohort_too_small");assert.deepEqual(small.items,[]);assert.equal(small.currentUser,null);
    for(const [type,period] of [["week",options.periods.week[0]!],["month",options.periods.month[0]!]] as const){const result=await miniappApi.rankings({campusId:"a",periodType:type,periodKey:period.key,grade:"all",level:"all",limit:50});assert.equal(result.status,"ready",`${type} ranking should be ready`)}

    const {createPage}=require("../../miniprogram/ui/controller.js") as {createPage(route:string):Record<string,any>};
    const page=createPage("ranking");page.setData=(patch:Record<string,unknown>)=>Object.assign(page.data,patch);
    await page.loadRankingOptions();assert.equal(page.data.rankingStatus,"choose_campus");
    page.setData({rankingCampusIndex:0});await page.loadRankings();assert.equal(page.data.rankingStatus,"ready");assert.equal(page.data.rankingItems.length,50);
    await page.loadRankings(page.data.rankingNextCursor);assert.equal(page.data.rankingItems.length,55);
    page.setData({sheet:"rankingDetail"});await page.loadRankingDetail(page.data.rankingCurrentUser.participantId);assert.equal(page.data.rankingDetail.quizzes.length,50);
    await page.loadRankingDetail(page.data.rankingDetail.participant.participantId,page.data.rankingDetailNextCursor);assert.equal(page.data.rankingDetail.quizzes.length,52);

    process.stdout.write(`ranking-page.smoke.passed schema=${schema} participants=55 pages=50+5 detail=50+2 periods=rolling7+week+month small=hidden ui=ready\n`);
  } finally {
    if(app)await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
    delete (globalThis as {wx?:unknown}).wx;
  }
}

main().catch((error:unknown)=>{process.stderr.write(`${error instanceof Error?error.stack??error.message:String(error)}\n`);process.exitCode=1});
