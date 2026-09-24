import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";

import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/api/app.ts";
import type { SessionServicePort } from "../src/api/session-routes.ts";
import type { AuthenticatedSession, CurrentUser, SessionTokenResponse } from "../src/auth/session-service.ts";
import { migrateUp } from "../src/database/migrator.ts";
import { RankingAggregationService } from "../src/ranking/aggregation-service.ts";
import { RankingQueryService } from "../src/ranking/query-service.ts";
import { RankingRebuildProcessor } from "../src/ranking/rebuild-processor.ts";

const { Pool } = pg;
const schema = `ranking_test_${randomBytes(8).toString("hex")}`;
if (!/^ranking_test_[a-f0-9]{16}$/.test(schema)) throw new Error("Invalid ranking test schema");
const config = loadConfig();
const adminPool = new Pool({ connectionString:config.databaseUrl, max:1 });
const pool = new Pool({ connectionString:config.databaseUrl, max:4, options:`-c search_path=${schema},public` });

class SmokeSession implements SessionServicePort{
  private readonly userId:string;
  constructor(userId:string){this.userId=userId}
  async createWechatSession():Promise<SessionTokenResponse>{throw new Error("unused")}
  async refreshSession():Promise<SessionTokenResponse>{throw new Error("unused")}
  async authenticateAccessToken(token:string):Promise<AuthenticatedSession>{
    if(token!=="ranking-smoke-token")throw new Error("unexpected token");
    return {userId:this.userId,sessionId:"22222222-2222-4222-8222-222222222222"};
  }
  async revokeSession():Promise<void>{throw new Error("unused")}
  async getCurrentUser():Promise<CurrentUser>{throw new Error("unused")}
}

async function seedBook(index: number): Promise<{ packageId: string; workId: string; pieceId: string }> {
  const workId=`rank-work-${index}`;
  const pieceId=`rank-piece-${index}`;
  await pool.query(
    `INSERT INTO works (id,title,author,series,ranking_category,status)
     VALUES ($1,$2,$3,'Ranking Series',$4,'published')`,
    [workId,`Ranking Book ${index}`,`Author ${index}`,index%2?"fiction":"nonfiction"],
  );
  await pool.query(
    `INSERT INTO pieces (id,work_id,title,status,word_count,ranking_level)
     VALUES ($1,$2,$3,'published',$4,$5)`,
    [pieceId,workId,`Ranking Book ${index}`,800+index*200,2.5+index*0.25],
  );
  const version=await pool.query<{id:string}>(
    `INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at)
     VALUES ($1,1,'published',true,$2,now()) RETURNING id`,
    [pieceId,String(index).padStart(64,"a").slice(-64).replace(/[^a-f0-9]/g,"a")],
  );
  await pool.query("UPDATE pieces SET current_content_version_id=$1 WHERE id=$2",[version.rows[0]!.id,pieceId]);
  const quizPackage=await pool.query<{id:string}>(
    `INSERT INTO quiz_packages (piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at)
     VALUES ($1,1,1,$2,'published',80,now()) RETURNING id`,
    [pieceId,String(index).padStart(64,"b").slice(-64).replace(/[^a-f0-9]/g,"b")],
  );
  return {packageId:quizPackage.rows[0]!.id,workId,pieceId};
}

async function insertAttempt(userId:string,book:{packageId:string;workId:string;pieceId:string},attemptId:string,score:number,submittedAt:Date):Promise<string>{
  const id=randomUUID();
  await pool.query(
    `INSERT INTO quiz_attempts (
       id,user_id,attempt_id,quiz_package_id,started_at,submitted_at,status,
       score,mastery,request_hash,verified_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'server_verified',$7,$8,$9,$6)`,
    [id,userId,attemptId,book.packageId,new Date(submittedAt.getTime()-60000),submittedAt,score,score>=80,"c".repeat(64)],
  );
  return id;
}

async function main():Promise<void>{
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  try{
    await migrateUp(pool,{schema});
    const books=[];
    for(let index=1;index<=6;index+=1)books.push(await seedBook(index));
    const startsAt=new Date(Date.now()+60000);
    const endsAt=new Date(startsAt.getTime()+7*86400000);
    const userIds:string[]=[];
    let expectedQuizRows=0;
    for(let index=0;index<10;index+=1){
      const userId=randomUUID();userIds.push(userId);
      await pool.query("INSERT INTO users (id) VALUES ($1)",[userId]);
      await pool.query(
        `INSERT INTO user_profiles (user_id,campus_id,grade,reading_level,profile_source,source_verified_at)
         VALUES ($1,'a','3','3','admin',now())`,
        [userId],
      );
      const bookCount=index+1>6?6:index+1;
      for(let bookIndex=0;bookIndex<bookCount;bookIndex+=1){
        await insertAttempt(userId,books[bookIndex]!,`attempt-${index}-${bookIndex}`,60+index*3+bookIndex,new Date(startsAt.getTime()+(index*10+bookIndex+1)*60000));
        expectedQuizRows+=1;
      }
    }
    const retryId=await insertAttempt(userIds[9]!,books[0]!,"attempt-9-retry",100,new Date(startsAt.getTime()+200*60000));
    expectedQuizRows+=1;

    const service=new RankingAggregationService(pool,config.auth.identityHashKeyBase64);
    const dimensions={periodType:"rolling7" as const,periodKey:"ranking-smoke",startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),campusId:"a",grade:"3",readingLevel:"3",minimumCohortSize:10,requestId:"ranking-smoke-001"};
    const firstComputation=await service.compute(dimensions);
    const secondComputation=await service.compute(dimensions);
    assert.deepEqual(secondComputation,firstComputation,"full recomputation must be deterministic");
    assert.equal(firstComputation.entries.length,10);
    assert.equal(firstComputation.entries[0]?.completedBooks,6);
    assert.ok(firstComputation.entries.every((entry)=>entry.score>=0&&entry.score<=1000));
    const retry=firstComputation.entries.flatMap((entry)=>entry.quizzes).find((quiz)=>quiz.quizAttemptId===retryId);
    assert.equal(retry?.countedInScore,false,"retakes stay visible but cannot change the score");

    const built=await service.build(dimensions);
    assert.equal(built.status,"ready");
    assert.equal(built.cohortSize,10);
    assert.equal(built.entries.length,10);
    const repeated=await service.build({...dimensions,requestId:"ranking-smoke-002"});
    assert.deepEqual(repeated,built,"snapshot build must be idempotent");
    const stored=await pool.query<{entries:string;quizzes:string;audits:string}>(
      `SELECT
         (SELECT count(*)::text FROM ranking_snapshot_entries WHERE snapshot_id=$1) AS entries,
         (SELECT count(*)::text FROM ranking_snapshot_quizzes WHERE snapshot_id=$1) AS quizzes,
         (SELECT count(*)::text FROM audit_events WHERE target_id=$1::text) AS audits`,
      [built.snapshotId],
    );
    assert.deepEqual(stored.rows[0],{entries:"10",quizzes:String(expectedQuizRows),audits:"1"});

    const queryService=new RankingQueryService(pool,config.auth.identityHashKeyBase64,()=>new Date(startsAt.getTime()+86400000));
    const options=await queryService.options();
    assert.deepEqual(options.campuses,[{value:"a",label:"A校区"},{value:"b",label:"B校区"}]);
    assert.equal(options.periods.week.length,12);
    assert.equal(options.periods.month.length,12);
    const firstPage=await queryService.rankings(userIds[0]!,{campusId:"a",periodType:"rolling7",grade:"3",level:"3"},undefined,3);
    assert.equal(firstPage.status,"ready");
    assert.equal(firstPage.items.length,3);
    assert.ok(firstPage.nextCursor);
    assert.ok(firstPage.currentUser);
    const secondPage=await queryService.rankings(userIds[0]!,{campusId:"a",periodType:"rolling7",grade:"3",level:"3"},firstPage.nextCursor!,3);
    assert.equal(secondPage.items.length,3);
    assert.equal(new Set([...firstPage.items,...secondPage.items].map((item)=>item.participantId)).size,6);
    const detail=await queryService.detail({campusId:"a",periodType:"rolling7",grade:"3",level:"3"},firstPage.items[0]!.participantId,undefined,1);
    assert.equal(detail.scoreBreakdown.length,6);
    assert.equal(detail.quizzes.length,1);
    assert.ok(detail.nextCursor);
    const detailPage2=await queryService.detail({campusId:"a",periodType:"rolling7",grade:"3",level:"3"},firstPage.items[0]!.participantId,detail.nextCursor!,1);
    assert.equal(detailPage2.quizzes.length,1);
    await assert.rejects(queryService.rankings(userIds[0]!,{campusId:"a",periodType:"rolling7",grade:"3",level:"3"},"forged.cursor",3),/Cursor is invalid/);
    await assert.rejects(queryService.rankings(userIds[0]!,{campusId:"missing",periodType:"rolling7",grade:"3",level:"3"},undefined,3),/Campus is invalid/);

    const app=createApp({sessionService:new SmokeSession(userIds[0]!),rankingService:queryService});
    const headers={authorization:"Bearer ranking-smoke-token"};
    const apiOptions=await app.inject({method:"GET",url:"/api/v1/ranking-options",headers});
    assert.equal(apiOptions.statusCode,200);
    assert.equal(apiOptions.json().ruleVersion,"quiz-score-v1");
    const apiList=await app.inject({method:"GET",url:"/api/v1/rankings?campusId=a&periodType=rolling7&grade=3&level=3&limit=2",headers});
    assert.equal(apiList.statusCode,200);
    assert.equal(apiList.json().status,"ready");
    assert.equal(apiList.json().items.length,2);
    assert.equal(apiList.json().items[0].metric.key,"rankingScore");
    const apiDetail=await app.inject({method:"GET",url:`/api/v1/rankings/${apiList.json().items[0].participantId}/quizzes?campusId=a&periodType=rolling7&grade=3&level=3&limit=2`,headers});
    assert.equal(apiDetail.statusCode,200);
    assert.equal(apiDetail.json().scoreBreakdown.length,6);
    await app.close();

    await pool.query("INSERT INTO ranking_rebuild_events (quiz_attempt_id) VALUES ($1)",[retryId]);
    const processor=new RankingRebuildProcessor(pool,service,()=>endsAt);
    assert.equal(await processor.processAvailable(1),1);
    const eventStatus=await pool.query<{status:string;attempts:number}>("SELECT status,attempts FROM ranking_rebuild_events WHERE quiz_attempt_id=$1",[retryId]);
    assert.deepEqual(eventStatus.rows[0],{status:"completed",attempts:1});

    const refreshAttempt=await insertAttempt(userIds[0]!,books[1]!,"attempt-refresh",99,new Date(startsAt.getTime()+250*60000));
    const refreshed=await service.build({...dimensions,requestId:"ranking-smoke-refresh"});
    assert.notEqual(refreshed.snapshotId,built.snapshotId,"changed source facts must create a new immutable snapshot version");
    const unchanged=await service.build({...dimensions,requestId:"ranking-smoke-refresh-repeat"});
    assert.equal(unchanged.snapshotId,refreshed.snapshotId,"unchanged source facts must reuse the exact snapshot version");
    await pool.query("UPDATE quiz_attempts SET withdrawn_at=now(),withdrawal_reason='integration test withdrawal' WHERE id=$1",[refreshAttempt]);
    const afterWithdrawal=await service.build({...dimensions,requestId:"ranking-smoke-withdrawal"});
    assert.notEqual(afterWithdrawal.snapshotId,refreshed.snapshotId,"withdrawal must produce a new snapshot version");
    const withdrawnRows=await pool.query<{count:string}>("SELECT count(*)::text AS count FROM ranking_snapshot_quizzes WHERE snapshot_id=$1 AND quiz_attempt_id=$2",[afterWithdrawal.snapshotId,refreshAttempt]);
    assert.equal(withdrawnRows.rows[0]?.count,"0");

    const smallUser=randomUUID();
    await pool.query("INSERT INTO users (id) VALUES ($1)",[smallUser]);
    await pool.query(
      `INSERT INTO user_profiles (user_id,campus_id,grade,reading_level,profile_source,source_verified_at)
       VALUES ($1,'b','3','3','admin',now())`,[smallUser],
    );
    await insertAttempt(smallUser,books[0]!,"small-attempt",90,new Date(startsAt.getTime()+300000));
    const small=await service.build({...dimensions,campusId:"b",periodKey:"ranking-smoke-small",requestId:"ranking-smoke-small"});
    assert.equal(small.status,"cohort_too_small");
    assert.equal(small.entries.length,0);
    assert.equal(small.cohortSize,1);
    const hidden=await queryService.rankings(smallUser,{campusId:"b",periodType:"rolling7",grade:"3",level:"3"},undefined,20);
    assert.equal(hidden.status,"cohort_too_small");
    assert.equal(hidden.items.length,0);
    assert.equal(hidden.currentUser,null);

    await pool.query("UPDATE user_profiles SET grade='4' WHERE user_id=$1",[userIds[0]]);
    const history=await pool.query<{count:string;closed:string}>(
      `SELECT count(*)::text AS count, count(*) FILTER (WHERE effective_until IS NOT NULL)::text AS closed
       FROM user_profile_versions WHERE user_id=$1`,[userIds[0]],
    );
    assert.deepEqual(history.rows[0],{count:"2",closed:"1"});
    process.stdout.write(`ranking.smoke.passed snapshot=${built.snapshotId} cohort=10 quizzes=${expectedQuizRows} retryCounted=false small=blocked\n`);
  }finally{
    await pool.end();
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

main().catch((error:unknown)=>{process.stderr.write(`${error instanceof Error?error.stack??error.message:String(error)}\n`);process.exitCode=1});
