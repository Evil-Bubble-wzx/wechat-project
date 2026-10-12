import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createApp } from "../src/api/app.ts";
import { SessionService } from "../src/auth/session-service.ts";
import { StubWechatIdentityProvider } from "../src/auth/wechat-provider.ts";
import { loadConfig } from "../src/config.ts";
import { migrateUp, rollbackOne } from "../src/database/migrator.ts";
import { QuizService, type QuizAttemptInput } from "../src/quiz/service.ts";
import { readLearningScore } from "../src/ranking/learning-score.ts";
import { RankingAggregationService } from "../src/ranking/aggregation-service.ts";
import { RankingQueryService, isoWeek, weekWindow, monthWindow, yearWindow, shanghaiDate } from "../src/ranking/query-service.ts";
import { RankingRebuildProcessor } from "../src/ranking/rebuild-processor.ts";
import { LocalImportService, localImportCanonical } from "../src/sync/local-import-service.ts";
import { ProgressSyncService } from "../src/sync/progress-sync-service.ts";

const { Pool } = pg;
const schema = `learning_points_${randomBytes(8).toString("hex")}`;
if (!/^learning_points_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid isolated schema");
const base = loadConfig();
const config = loadConfig({ APP_ENV:"test", DATABASE_URL:base.databaseUrl, WECHAT_PROVIDER:"stub" });
const admin = new Pool({ connectionString:config.databaseUrl, max:1 });
const pool = new Pool({ connectionString:config.databaseUrl, max:8, options:`-c search_path=${schema},public`, statement_timeout:15000 });
const questionIds = Array.from({length:5},(_,index)=>`points-q${index}`);
const pieceId = "points-piece", workId = "points-work";
const historicalUser = randomUUID();
let packageId = "", historicalAttempt = "", address = "", accessToken = "";

async function profile(userId:string):Promise<void> {
  await pool.query("INSERT INTO user_profiles (user_id,campus_id,grade,reading_level,profile_source,source_verified_at) VALUES ($1,'a','3','3','admin',now())",[userId]);
  await pool.query("UPDATE user_profile_versions SET effective_from=now()-interval '2 years' WHERE user_id=$1",[userId]);
}
async function seed():Promise<void> {
  await pool.query("INSERT INTO works (id,title,status,access_type) VALUES ($1,'Points Book','published','free')",[workId]);
  await pool.query("INSERT INTO pieces (id,work_id,title,status,access_type,word_count) VALUES ($1,$2,'Points Book','published','free',100)",[pieceId,workId]);
  const version=await pool.query<{id:string}>("INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ($1,1,'published',true,$2,now()) RETURNING id",[pieceId,"a".repeat(64)]);
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id=$2",[version.rows[0]!.id,pieceId]);
  await pool.query("INSERT INTO content_assets (piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES ($1,1,'audio','test','points.mp3',$2,1,'audio/mpeg',10000,'published')",[pieceId,"b".repeat(64)]);
  const quiz=await pool.query<{id:string}>("INSERT INTO quiz_packages (piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES ($1,1,1,$2,'published',80,now()) RETURNING id",[pieceId,"c".repeat(64)]);
  packageId=quiz.rows[0]!.id;
  for(const [index,id] of questionIds.entries())await pool.query("INSERT INTO quiz_questions (quiz_package_id,question_id,prompt,options,correct_option,sort_order) VALUES ($1,$2,'Question','[0,1]'::jsonb,0,$3)",[packageId,id,index]);
}
function attempt(id:string,selectedOptions:number[]):QuizAttemptInput {
  const submittedAt=new Date().toISOString();
  return {schemaVersion:1,attemptId:id,workId,pieceId,contentVersion:1,quizVersion:1,questionIds,selectedOptions,startedAt:submittedAt,submittedAt};
}
async function request(path:string,method="GET",body?:unknown,key?:string):Promise<any> {
  const response=await fetch(address+path,{method,headers:{"content-type":"application/json",...(accessToken?{authorization:"Bearer "+accessToken}:{}),...(key?{"idempotency-key":key}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const value=await response.json();
  assert.equal(response.status,path==='/api/v1/session/wechat'?201:200,JSON.stringify(value.error??{status:response.status}));
  return value;
}
async function progress(id:string,end:number,baseRevision="0",start=0,contentVersion=1):Promise<any> {
  return request("/api/v1/me/progress/"+pieceId,"PUT",{schemaVersion:1,mutationId:id,baseRevision,contentVersion,checkpointMs:end,listenedRangesMs:[[start,end]]},id);
}
async function quiz(input:QuizAttemptInput):Promise<any> {
  return request("/api/v1/me/quiz-attempts","POST",input,input.attemptId);
}

async function main():Promise<void> {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  let app:ReturnType<typeof createApp>|undefined;
  try {
    await migrateUp(pool,{schema});
    for(const version of ["0015_ranking_quiz_analysis","0014_quiz_history","0013_content_catalog_projection","0012_reader_library","0011_learning_score_consistency","0010_learning_points"])assert.equal(await rollbackOne(pool,{schema}),version);
    await seed();await pool.query("INSERT INTO users (id) VALUES ($1)",[historicalUser]);await profile(historicalUser);
    await pool.query("INSERT INTO user_learning_progress (user_id,piece_id,content_version,duration_ms,checkpoint_ms,listened_ranges_ms,listened_ms,coverage,completed,source_updated_at,source_snapshot_id,server_updated_at) VALUES ($1,$2,1,10000,10000,'[[0,10000]]',10000,1,true,now()-interval '40 days','historical',now()-interval '40 days')",[historicalUser,pieceId]);
    historicalAttempt=randomUUID();
    await pool.query("INSERT INTO quiz_attempts (id,user_id,attempt_id,quiz_package_id,started_at,submitted_at,status,score,mastery,request_hash,verified_at) VALUES ($1,$2,'historical-quiz',$3,now()-interval '40 days',now()-interval '40 days','server_verified',60,false,$4,now()-interval '40 days')",[historicalAttempt,historicalUser,packageId,"d".repeat(64)]);
    await pool.query("INSERT INTO quiz_answers (quiz_attempt_id,quiz_question_id,selected_option,is_correct) SELECT $1,id,CASE WHEN sort_order<3 THEN 0 ELSE 1 END,sort_order<3 FROM quiz_questions WHERE quiz_package_id=$2",[historicalAttempt,packageId]);
    const legacy=await pool.query<{id:string}>("INSERT INTO ranking_snapshots (period_type,period_key,starts_at,ends_at,campus_id,rule_version,status,generated_at,result_status,cohort_size) VALUES ('year','legacy',now()-interval '1 year',now(),'a','quiz-score-v1','ready',now(),'ready',10) RETURNING id");
    await pool.query("INSERT INTO ranking_snapshot_entries (snapshot_id,user_id,participant_id,display_name,rank,score,completed_books,total_words,adjusted_accuracy,score_breakdown,stats) VALUES ($1,$2,'legacy-reader','Legacy',1,987,1,100,60,'[]','{}')",[legacy.rows[0]!.id,historicalUser]);
    await migrateUp(pool,{schema});
    assert.equal((await readLearningScore(pool,historicalUser)).totalPoints,"90","historical progress and correct answers are backfilled");
    assert.equal((await pool.query("SELECT score::text FROM ranking_snapshot_entries WHERE snapshot_id=$1",[legacy.rows[0]!.id])).rows[0].score,"987","v1 snapshot remains intact");
    for(const version of ["0015_ranking_quiz_analysis","0014_quiz_history","0013_content_catalog_projection","0012_reader_library","0011_learning_score_consistency"])assert.equal(await rollbackOne(pool,{schema}),version);
    await assert.rejects(rollbackOne(pool,{schema}),/Learning points exist/);
    await migrateUp(pool,{schema});

    const sessions=new SessionService(pool,new StubWechatIdentityProvider(),config),quizService=new QuizService(pool);
    const aggregation=new RankingAggregationService(pool,config.auth.identityHashKeyBase64);
    app=createApp({appEnv:"test",sessionService:sessions,quizService,progressSyncService:new ProgressSyncService(pool),rankingService:new RankingQueryService(pool,config.auth.identityHashKeyBase64)});
    address=await app.listen({host:"127.0.0.1",port:0});
    assert.equal((await fetch(address+"/api/v1/me/learning-score")).status,401);
    const me=await request("/api/v1/session/wechat","POST",{code:"test:learning-points-user",deviceId:"points-test-device"},"points-login-001");
    accessToken=me.accessToken;await profile(me.userId);
    assert.equal((await request("/api/v1/me/learning-score")).totalPoints,"0");
    let update=await progress("points-partial-01",500);assert.equal(update.learningScore.totalPoints,"0");
    update=await progress("points-partial-02",1000,update.progress.revision);assert.equal(update.learningScore.totalPoints,"1");
    const duplicate=await progress("points-partial-02",1000,"1");assert.equal(duplicate.duplicate,true);assert.equal(duplicate.learningScore.totalPoints,"1");
    update=await progress("points-partial-03",1500,update.progress.revision);assert.equal(update.learningScore.totalPoints,"1");
    update=await progress("points-partial-04",2500,update.progress.revision);assert.equal(update.learningScore.totalPoints,"2");
    update=await progress("points-repeat-01",2000,update.progress.revision);assert.equal(update.learningScore.totalPoints,"2");
    await Promise.all([progress("points-concurrent-01",5000,update.progress.revision,3000),progress("points-concurrent-02",8000,update.progress.revision,5000)]);
    assert.equal((await request("/api/v1/me/learning-score")).totalPoints,"7","concurrent ranges are merged without double credits");
    update=await progress("points-completion-01",10000);assert.equal(update.progress.completed,true);assert.equal(update.learningScore.totalPoints,"60");
    update=await progress("points-completion-02",10000,update.progress.revision);assert.equal(update.learningScore.totalPoints,"60");
    const first=attempt("points-quiz-first",[0,0,0,1,1]);
    assert.equal((await quiz(first)).learningScore.totalPoints,"90");
    assert.equal((await quiz(first)).learningScore.totalPoints,"90","idempotent Quiz does not add credits");
    assert.equal((await quiz(attempt("points-quiz-improved",[0,0,0,0,0]))).learningScore.totalPoints,"110");
    assert.equal((await quiz(attempt("points-quiz-repeated",[0,0,0,0,0]))).learningScore.totalPoints,"110");
    assert.equal((await quiz({...attempt("points-quiz-rejected",[0,0,0,0,0]),questionIds:[...questionIds].reverse()})).status,"rejected");

    // One mixed import transaction must own both progress and Quiz credits.
    const importer=randomUUID();await pool.query("INSERT INTO users (id) VALUES ($1)",[importer]);await profile(importer);
    const payload={schemaVersion:1 as const,progress:[{pieceId,contentVersion:1,durationMs:10000,checkpointMs:2000,listenedRangesMs:[[0,2000]] as Array<[number,number]>,updatedAt:new Date().toISOString()}],words:[],quizAttempts:[attempt("points-import-quiz",[0,0,0,0,0])]};
    const input={snapshotId:localImportCanonical.snapshotFor(payload),payload,limitations:{words:"surface_only" as const}};
    const importService=new LocalImportService(pool,quizService);
    const [imported,concurrentQuiz]=await Promise.all([importService.import(importer,input),quizService.submit(importer,payload.quizAttempts[0]!)]);
    assert.equal(imported.status,"completed");assert.equal(concurrentQuiz.status,"server_verified");
    assert.equal((await importService.import(importer,input)).duplicate,true);
    assert.equal((await readLearningScore(pool,importer)).totalPoints,"52");

    // Withdrawal and later new answers rebuild the original earned period.
    await pool.query("UPDATE ranking_rebuild_events SET status='completed',completed_at=now()");
    await pool.query("UPDATE quiz_attempts SET withdrawn_at=now(),withdrawal_reason='smoke' WHERE id=$1",[historicalAttempt]);
    assert.equal((await readLearningScore(pool,historicalUser)).totalPoints,"60");
    const invalidations=await pool.query<{id:string;earned_at:Date}>("SELECT id,earned_at FROM ranking_rebuild_events WHERE invalidated_score_event_id IS NOT NULL AND user_id=$1",[historicalUser]);
    assert.equal(invalidations.rows.length,3);assert.ok(invalidations.rows.every(row=>row.earned_at.getTime()<Date.now()-30*86400000));
    assert.equal(await new RankingRebuildProcessor(pool,aggregation).processAvailable(1),1);
    assert.equal((await pool.query("SELECT count(*)::text AS count FROM ranking_rebuild_events WHERE invalidated_score_event_id IS NOT NULL AND user_id=$1 AND status='completed'",[historicalUser])).rows[0].count,"1");
    await quizService.submit(historicalUser,attempt("points-historical-retake",[0,0,0,0,0]));
    assert.equal((await readLearningScore(pool,historicalUser)).totalPoints,"110");
    const restored=await pool.query("SELECT count(*)::text AS count FROM ranking_rebuild_events WHERE invalidated_score_event_id IS NOT NULL AND user_id=$1",[historicalUser]);
    assert.equal(restored.rows[0].count,"6","new correct answers restore original-period credits without duplicating the ledger");

    await pool.query("UPDATE quiz_attempts SET withdrawn_at=now(),withdrawal_reason='smoke' WHERE user_id=$1 AND attempt_id IN ('points-quiz-improved','points-quiz-repeated')",[me.userId]);
    assert.equal((await request('/api/v1/me/learning-score')).totalPoints,'90','only still-valid correct answers count');
    await pool.query("UPDATE quiz_attempts SET withdrawn_at=NULL,withdrawal_reason=NULL WHERE user_id=$1 AND attempt_id='points-quiz-improved'",[me.userId]);
    assert.equal((await request('/api/v1/me/learning-score')).totalPoints,'110','restoring an attempt restores original credits');
    assert.equal((await pool.query("SELECT count(*)::text AS count FROM learning_score_events WHERE user_id=$1 AND kind='quizCorrect'",[me.userId])).rows[0].count,'5');

    // A confirmed read waits for an in-flight credit transaction to commit.
    const writer=await pool.connect();
    try{
      await writer.query("BEGIN");
      await writer.query("INSERT INTO learning_score_events (user_id,piece_id,event_key,kind,points,earned_at) VALUES ($1,$2,'test-pending-credit','listening',7,now())",[me.userId,pieceId]);
      let finished=false;
      const pendingRead=request("/api/v1/me/learning-score").then(value=>{finished=true;return value});
      await new Promise(resolve=>setTimeout(resolve,30));assert.equal(finished,false);
      await writer.query("COMMIT");assert.equal((await pendingRead).totalPoints,"117");
    }finally{await writer.query("ROLLBACK");writer.release()}

    // Version changes do not reset the per-piece high-water or completion reward.
    const next=await pool.query<{id:string}>("INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ($1,2,'published',true,$2,now()) RETURNING id",[pieceId,"e".repeat(64)]);
    await pool.query("UPDATE content_versions SET status='superseded' WHERE piece_id=$1 AND content_version=1",[pieceId]);
    await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id=$2",[next.rows[0]!.id,pieceId]);
    await pool.query("INSERT INTO content_assets (piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES ($1,2,'audio','test','points-v2.mp3',$2,1,'audio/mpeg',10000,'published')",[pieceId,"f".repeat(64)]);
    assert.equal((await progress("points-version-02",10000,"0",0,2)).learningScore.totalPoints,"117");

    const precise=randomUUID(),huge="900719925474099312345678901";
    await pool.query("INSERT INTO users (id) VALUES ($1)",[precise]);await profile(precise);
    // Synthetic ledger fact tests NUMERIC/string transport, not real audio length.
    await pool.query("INSERT INTO learning_score_events (user_id,piece_id,event_key,kind,points,earned_at) VALUES ($1,$2,'test-exact-large','listening',$3,now())",[precise,pieceId,huge]);
    assert.equal((await readLearningScore(pool,precise)).totalPoints,huge);
    const now=new Date(),week=isoWeek(now),local=shanghaiDate(now);
    const month=`${local.getUTCFullYear()}-${String(local.getUTCMonth()+1).padStart(2,"0")}`,year=String(local.getUTCFullYear()),weekKey=`${week.year}-W${String(week.week).padStart(2,"0")}`;
    const windows=[{type:"rolling7" as const,key:"points-rolling",startsAt:new Date(now.getTime()-7*86400000),endsAt:new Date(now.getTime()+1000)},{type:"week" as const,key:weekKey,...weekWindow(weekKey)},{type:"month" as const,key:month,...monthWindow(month)},{type:"year" as const,key:year,...yearWindow(year)}];
    for(const window of windows){
      const dimensions={periodType:window.type,periodKey:window.key,startsAt:window.startsAt.toISOString(),endsAt:window.endsAt.toISOString(),campusId:"a",grade:"3",readingLevel:"3",minimumCohortSize:1,requestId:"points-period-"+window.type};
      const computed=await aggregation.compute(dimensions);
      assert.equal(computed.entries[0]!.score,huge);
      assert.equal(computed.entries.find(entry=>entry.userId===me.userId)!.score,"117");
      if(window.type!=="year")assert.equal(computed.entries.find(entry=>entry.userId===historicalUser)!.score,"20","period counts new credits, not lifetime total");
      const built=await aggregation.build(dimensions);
      assert.equal(built.entries[0]!.metric.value,huge);
      assert.equal((await pool.query("SELECT score::text FROM ranking_snapshot_entries WHERE snapshot_id=$1 AND user_id=$2",[built.snapshotId,precise])).rows[0].score,huge);
    }
    assert.equal((await request("/api/v1/me/learning-score")).totalPoints,"117","other participants never change personal points");
    for(const version of ["0015_ranking_quiz_analysis","0014_quiz_history","0013_content_catalog_projection","0012_reader_library"])assert.equal(await rollbackOne(pool,{schema}),version);
    await assert.rejects(rollbackOne(pool,{schema}),/Score invalidation tasks exist/);
    process.stdout.write("learning-points.smoke.passed historical=v1-preserved fractions=accumulated repeats=deduped concurrent=merged completion=once quiz=improved import=atomic withdrawal=queued read=serialized versions=no-reset precision=exact periods=4\n");
  }finally{
    if(app)await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
main().catch((error:unknown)=>{process.stderr.write(`${error instanceof Error?error.stack??error.message:String(error)}\n`);process.exitCode=1});
