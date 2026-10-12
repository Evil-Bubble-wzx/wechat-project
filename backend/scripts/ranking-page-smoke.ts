import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { createApp } from "../src/api/app.ts";
import { SessionService } from "../src/auth/session-service.ts";
import { StubWechatIdentityProvider } from "../src/auth/wechat-provider.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp,rollbackOne } from "../src/database/migrator.ts";
import { RankingAggregationService } from "../src/ranking/aggregation-service.ts";
import {ProgressSyncService} from "../src/sync/progress-sync-service.ts";
import {SavedWordSyncService} from "../src/sync/saved-word-sync-service.ts";
import {ReaderLibraryService} from "../src/sync/reader-library-service.ts";
import {LearningHistoryService} from "../src/quiz/history-service.ts";
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
  await pool.query(`INSERT INTO quiz_questions (quiz_package_id,question_id,prompt,options,correct_option,sort_order)
    SELECT $1,'question-'||n,'Ranking page question','["Correct","Wrong"]'::jsonb,0,n FROM generate_series(0,9) n`,[quiz.rows[0]!.id]);
  return {packageId:quiz.rows[0]!.id};
}

async function addAttempt(userId:string,packageId:string,label:string,score:number,submittedAt:Date):Promise<void> {
  const id=randomUUID();
  await pool.query(`INSERT INTO quiz_attempts (id,user_id,attempt_id,quiz_package_id,started_at,submitted_at,status,score,mastery,request_hash,verified_at) VALUES ($1,$2,$3,$4,$5,$6,'server_verified',$7,$8,$9,$6)`,[id,userId,label,packageId,new Date(submittedAt.getTime()-60_000),submittedAt,score,score>=80,"c".repeat(64)]);
  await pool.query(`INSERT INTO quiz_answers (quiz_attempt_id,quiz_question_id,selected_option,is_correct)
    SELECT $1,id,CASE WHEN sort_order < floor($3::numeric/10) THEN 0 ELSE 1 END,sort_order < floor($3::numeric/10)
    FROM quiz_questions WHERE quiz_package_id=$2`,[id,packageId,score]);
}

async function main():Promise<void> {
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  let app:ReturnType<typeof createApp>|undefined;
  try {
    await migrateUp(pool,{schema});
    const book=await seedBook();
    const sessionService=new SessionService(pool,new StubWechatIdentityProvider(),config);
    let queryTime=new Date();
    const rankingQuery=new RankingQueryService(pool,config.auth.identityHashKeyBase64,()=>queryTime);
    app=createApp({appEnv:"test",sessionService,rankingService:rankingQuery,progressSyncService:new ProgressSyncService(pool),savedWordSyncService:new SavedWordSyncService(pool,config.auth.identityHashKeyBase64),readerLibraryService:new ReaderLibraryService(pool,config.auth.identityHashKeyBase64),learningHistoryService:new LearningHistoryService(pool,config.auth.identityHashKeyBase64)});
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
      rankings(filters:Record<string,unknown>):Promise<{snapshotId:string;status:string;items:Array<{participantId:string}>;currentUser:{participantId:string}|null;nextCursor:string|null}>;
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

    queryTime=new Date();
    const concurrent=await Promise.all(Array.from({length:8},()=>miniappApi.rankings({campusId:"a",periodType:"rolling7",grade:"all",level:"all",limit:50})));
    assert.equal(new Set(concurrent.map(response=>response.snapshotId)).size,1,"concurrent first-page requests must share the current rolling snapshot");
    const first=concurrent[0]!;
    assert.equal(first.status,"ready");assert.equal(first.items.length,50);assert.ok(first.nextCursor);assert.ok(first.currentUser);
    const second=await miniappApi.rankings({campusId:"a",periodType:"rolling7",grade:"all",level:"all",cursor:first.nextCursor,limit:50});
    assert.equal(second.items.length,5);assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.items,...second.items].map(item=>item.participantId)).size,55,"ranking pages must not overlap");
    const detail1=await miniappApi.rankingDetail(first.currentUser!.participantId,{campusId:"a",periodType:"rolling7",grade:"all",level:"all",snapshotId:first.snapshotId,limit:50});
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
    const detailPage=createPage("ranking-detail");detailPage.setData=(patch:Record<string,unknown>)=>Object.assign(detailPage.data,patch);
    detailPage.onLoad({...page.rankingScopeFilters,participantId:page.data.rankingCurrentUser.participantId});await detailPage.load();
    assert.equal(detailPage.data.status,"ready");assert.equal(detailPage.data.quizzes.length,50);
    await detailPage.more();assert.equal(detailPage.data.quizzes.length,52);assert.equal(detailPage.data.detail.attempts,52);
    const baseAnalysis=await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{campusId:"a",periodType:"rolling7",snapshotId:first.snapshotId,limit:50});
    assert.equal(baseAnalysis.stats.all.pieces,1);assert.equal(baseAnalysis.stats.all.words,"1200");
    assert.equal(baseAnalysis.stats.all.trendReady,false);
    const apiSchema=JSON.parse(require("node:fs").readFileSync(new URL("../contracts/schemas/api-v1.schema.json",import.meta.url),"utf8"));
    const {Ajv2020}=require("ajv/dist/2020.js"),ajv=new Ajv2020({strict:true});require("ajv-formats")(ajv);ajv.addSchema(apiSchema);
    const validate=ajv.getSchema(apiSchema.$id+"#/$defs/QuizAnalysisResponse");assert.equal(validate(baseAnalysis),true,JSON.stringify(validate.errors));
    for(let index=0;index<6;index++){
      const piece="analysis-piece-"+index,title=index===0?"Alpha% Story":index===5?"Zeta_ Story":"Chapter "+index;
      await pool.query("INSERT INTO pieces(id,work_id,title,status,word_count,ranking_level,sort_order) VALUES($1,'ranking-page-work',$2,'published',$3,$4,$5)",[piece,title,index===5?null:100+index,index===5?null:3+index/10,index+1]);
      const cv=(await pool.query("INSERT INTO content_versions(piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES($1,1,'published',true,$2,now()) RETURNING id",[piece,"d".repeat(64)])).rows[0]!;
      await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id=$2",[cv.id,piece]);
      const qp=(await pool.query("INSERT INTO quiz_packages(piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES($1,1,1,$2,'published',80,now()) RETURNING id",[piece,"e".repeat(64)])).rows[0]!;
      await pool.query("INSERT INTO quiz_questions(quiz_package_id,question_id,prompt,options,correct_option,sort_order) SELECT $1,'analysis-'||n,'Question','[\"Correct\",\"Wrong\"]'::jsonb,0,n FROM generate_series(0,9)n",[qp.id]);
      await addAttempt(me.userId,qp.id,"analysis-new-"+index,50+index*10,new Date(Date.now()-90000-index*1000));
    }
    const rebuilt=await aggregation.build({periodType:"rolling7",periodKey:"analysis-new",startsAt:rollingStart.toISOString(),endsAt:new Date(now.getTime()+60000).toISOString(),campusId:"a",grade:null,readingLevel:null,requestId:"analysis-new"});
    const analysisFilters={campusId:"a",periodType:"rolling7",snapshotId:rebuilt.snapshotId,limit:50};
    const analysis=await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,analysisFilters);
    assert.equal(validate(analysis),true,JSON.stringify(validate.errors));assert.equal(analysis.totalMatches,58);assert.equal(analysis.stats.all.pieces,7);assert.equal(analysis.stats.passed.pieces,3);
    assert.equal(analysis.stats.all.words,null);assert.equal(analysis.stats.passed.words,null);assert.equal(analysis.stats.all.trendReady,true);
    assert.equal(analysis.stats.all.earlyLevel,null);assert.equal(analysis.stats.all.leveledPieces,6);
    const nextAnalysis=await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,cursor:analysis.nextCursor});
    assert.equal(nextAnalysis.quizzes.length,8);assert.equal(new Set([...analysis.quizzes,...nextAnalysis.quizzes].map((row:any)=>row.attemptId)).size,58);
    for(const query of ["%","_"])assert.equal((await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,query})).totalMatches,1);
    assert.equal((await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,query:"' OR 1=1 --"})).totalMatches,0);
    for(const sort of ["date","title","accuracy","level","words","quizPoints"])for(const direction of ["asc","desc"]){
      const sorted:any=await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,sort,direction,limit:100});
      assert.equal(sorted.quizzes.length,58);assert.equal(validate(sorted),true);
      if(["words","level"].includes(sort))assert.equal(sorted.quizzes.at(-1)[sort==="words"?"wordCount":"level"],null);
    }
    for(const changed of [{query:"Story"},{sort:"words"},{direction:"asc"},{snapshotId:first.snapshotId}]){
      await assert.rejects((miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,...changed,cursor:analysis.nextCursor}));
    }
    await assert.rejects((miniappApi as any).rankingAnalysis(first.items.find(item=>item.participantId!==first.currentUser!.participantId)!.participantId,{...analysisFilters,cursor:analysis.nextCursor}));
    await assert.rejects((miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,campusId:"b"}));
    assert.doesNotMatch(JSON.stringify(analysis),/selectedOptions|user_id|openid|phone/);
    const pinned=await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,snapshotId:first.snapshotId});
    assert.equal(pinned.totalMatches,52);assert.equal(pinned.stats.all.pieces,1);
    // Metadata is part of the immutable analysis source, not just the score.
    await pool.query("UPDATE works SET author='Updated Author' WHERE id='ranking-page-work'");
    const metadataBuild=await aggregation.build({periodType:"rolling7",periodKey:"analysis-new",startsAt:rollingStart.toISOString(),endsAt:new Date(now.getTime()+60000).toISOString(),campusId:"a",grade:null,readingLevel:null,requestId:randomUUID()});
    assert.notEqual(metadataBuild.snapshotId,analysis.snapshotId);
    const metadataAnalysis=await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,snapshotId:metadataBuild.snapshotId,query:"Updated Author"});
    assert.equal(metadataAnalysis.totalMatches,58);
    const oldMetadata=await (miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,query:"Updated Author"});
    assert.equal(oldMetadata.totalMatches,0);
    await pool.query("UPDATE ranking_snapshots SET analysis_version=0 WHERE id=$1",[first.snapshotId]);await pool.query("UPDATE ranking_snapshot_entries SET quiz_analysis=NULL WHERE snapshot_id=$1",[first.snapshotId]);
    await assert.rejects((miniappApi as any).rankingAnalysis(first.currentUser!.participantId,{...analysisFilters,snapshotId:first.snapshotId}));
    assert.equal(await rollbackOne(pool,{schema}),"0019_bulk_content_import");assert.equal(await rollbackOne(pool,{schema}),"0018_ingestion_operations");assert.equal(await rollbackOne(pool,{schema}),"0017_upload_recovery");assert.equal(await rollbackOne(pool,{schema}),"0016_student_profile_management");
    assert.equal(await rollbackOne(pool,{schema}),"0015_ranking_quiz_analysis");
    await migrateUp(pool,{schema});
    const refreshed=await miniappApi.rankings({campusId:"a",periodType:"rolling7",limit:50});
    assert.notEqual(refreshed.snapshotId,first.snapshotId);assert.equal(refreshed.status,"ready");
    if(process.argv.includes("--browser"))await require("../../tools/ranking-detail-browser-check.js")(address);

    process.stdout.write(`ranking-page.smoke.passed schema=${schema} participants=55 pages=50+5 detail=50+2 analysis=50+8 passedAll=distinct trend=6 search=literal sort=12 cursor=scoped snapshots=immutable rollback=rebuild periods=rolling7+week+month small=hidden ui=ready\n`);
  } finally {
    if(app)await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
    delete (globalThis as {wx?:unknown}).wx;
  }
}

main().catch((error:unknown)=>{process.stderr.write(`${error instanceof Error?error.stack??error.message:String(error)}\n`);process.exitCode=1});
