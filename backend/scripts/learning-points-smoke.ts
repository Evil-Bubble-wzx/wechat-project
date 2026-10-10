import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../src/config.ts";
import { discoverMigrations } from "../src/database/migrator.ts";
import { readLearningScore } from "../src/ranking/learning-score.ts";
import { RankingAggregationService } from "../src/ranking/aggregation-service.ts";
import { RankingRebuildProcessor } from "../src/ranking/rebuild-processor.ts";

const schema=`points_test_${randomBytes(8).toString('hex')}`;
const config=loadConfig();
const admin=new pg.Pool({connectionString:config.databaseUrl,max:1});
const pool=new pg.Pool({connectionString:config.databaseUrl,max:8,options:`-c search_path=${schema},public`});
const sept=new Date('2026-09-15T08:00:00Z'),oct=new Date('2026-10-10T08:00:00Z');
let packageId:string,questionId:string;
async function total(user:string):Promise<string>{return (await readLearningScore(pool,user)).totalPoints;}
async function user():Promise<string>{
  const id=randomUUID();await pool.query('INSERT INTO users (id) VALUES ($1)',[id]);
  await pool.query(`INSERT INTO user_profiles (user_id,campus_id,profile_source,source_verified_at)
    VALUES ($1,'a','admin',now())`,[id]);
  await pool.query(`UPDATE user_profile_versions SET effective_from='2026-01-01T00:00:00Z' WHERE user_id=$1`,[id]);
  return id;
}
async function progress(id:string,ms:number,version=1,completed=false):Promise<void>{
  await pool.query(`INSERT INTO user_learning_progress
    (user_id,piece_id,content_version,duration_ms,checkpoint_ms,listened_ranges_ms,listened_ms,coverage,completed,source_updated_at,source_snapshot_id,server_updated_at)
    VALUES ($1,'points-piece',$3,10000,$2,jsonb_build_array(jsonb_build_array(0,$2::integer)),$2,$2::numeric/10000,$4,$5,'fixture',$5)
    ON CONFLICT (user_id,piece_id,content_version) DO UPDATE SET listened_ms=EXCLUDED.listened_ms,
    listened_ranges_ms=EXCLUDED.listened_ranges_ms,checkpoint_ms=EXCLUDED.checkpoint_ms,
    coverage=EXCLUDED.coverage,completed=EXCLUDED.completed,server_updated_at=EXCLUDED.server_updated_at`,[id,ms,version,completed,oct]);
}
async function quiz(id:string,date:Date,correct=true):Promise<string>{
  const attempt=randomUUID();
  await pool.query(`INSERT INTO quiz_attempts
    (id,user_id,attempt_id,quiz_package_id,started_at,submitted_at,status,score,mastery,request_hash,verified_at)
    VALUES ($1::uuid,$2,$1::text,$3,$4,$4,'server_verified',$5,$6,$7,$4)`,[attempt,id,packageId,date,correct?100:0,correct,'c'.repeat(64)]);
  await pool.query(`INSERT INTO quiz_answers (quiz_attempt_id,quiz_question_id,selected_option,is_correct)
    VALUES ($1,$2,$3,$4)`,[attempt,questionId,correct?0:1,correct]);
  return attempt;
}
async function main():Promise<void>{
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try{
    const migrations=await discoverMigrations();
    // Exercise real pre-v2 rows and the migration's opening balance.
    for(const migration of migrations.slice(0,-1))await pool.query(migration.upSql);
    await pool.query(`INSERT INTO works (id,title,status) VALUES ('points-work','Points fixture','published')`);
    await pool.query(`INSERT INTO pieces (id,work_id,title,status) VALUES ('points-piece','points-work','Points fixture','published')`);
    await pool.query(`INSERT INTO content_versions (piece_id,content_version,status,publishable,manifest_sha256,published_at)
      VALUES ('points-piece',1,'published',true,$1,now()),('points-piece',2,'published',true,$1,now())`,['a'.repeat(64)]);
    packageId=(await pool.query<{id:string}>(`INSERT INTO quiz_packages
      (piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at)
      VALUES ('points-piece',1,1,$1,'published',80,now()) RETURNING id`,['a'.repeat(64)])).rows[0]!.id;
    questionId=(await pool.query<{id:string}>(`INSERT INTO quiz_questions
      (quiz_package_id,question_id,prompt,options,correct_option,sort_order)
      VALUES ($1,'logical-q1','Question','["right","wrong"]',0,0) RETURNING id`,[packageId])).rows[0]!.id;
    const historical=await user();await progress(historical,9000,1,true);await quiz(historical,sept);
    const client=await pool.connect();
    try{await client.query('BEGIN');await client.query(migrations.at(-1)!.upSql);await client.query('COMMIT');}finally{client.release();}
    assert.equal(await total(historical),'69');
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM learning_score_events WHERE user_id=$1 AND NOT historical`,[historical])).rows[0].n,0);
    const aggregation=new RankingAggregationService(pool,config.auth.identityHashKeyBase64);
    const dimension={periodType:'month' as const,periodKey:'2026-10',startsAt:'2026-09-30T16:00:00Z',endsAt:'2026-10-31T16:00:00Z',campusId:'a',grade:null,readingLevel:null,requestId:'points-smoke'};
    assert.equal((await aggregation.compute(dimension)).entries.length,0,'historical opening balance must not enter any period');
    await progress(historical,10000,1,true);assert.equal(await total(historical),'70');
    assert.equal((await aggregation.compute(dimension)).entries[0]!.score,'1','only new seconds enter period');

    const learner=await user();
    await progress(learner,999);assert.equal(await total(learner),'0');
    await progress(learner,1500);assert.equal(await total(learner),'1');
    await progress(learner,1999);assert.equal(await total(learner),'1');
    await progress(learner,2000);assert.equal(await total(learner),'2');
    await progress(learner,2000);assert.equal(await total(learner),'2');
    await progress(learner,9000,1,true);assert.equal(await total(learner),'59');
    await progress(learner,9000,2,true);assert.equal(await total(learner),'59','new version must not reset rewards');
    await Promise.all([progress(learner,10000,1,true),progress(learner,10000,2,true)]);
    assert.equal(await total(learner),'60','concurrent versions must share high water');
    await quiz(learner,oct,false);assert.equal(await total(learner),'60');
    await quiz(learner,oct);await quiz(learner,oct);assert.equal(await total(learner),'70');

    // Ten eligible learners allow worker-built snapshots instead of manual builds.
    const cohort:string[]=[],attempts:string[]=[];
    for(let i=0;i<10;i++){const id=await user();cohort.push(id);attempts.push(await quiz(id,sept));}
    const worker=new RankingRebuildProcessor(pool,aggregation,()=>new Date('2026-10-10T08:01:00Z'));
    await worker.processAvailable(500);
    const periodScore=async(id:string,key:string):Promise<string>=>{
      const result=await pool.query<{score:string}>(`SELECT COALESCE(entry.score,0)::text AS score
        FROM ranking_snapshots snapshot LEFT JOIN ranking_snapshot_entries entry ON entry.snapshot_id=snapshot.id AND entry.user_id=$1
        WHERE snapshot.period_type='month' AND snapshot.period_key=$2 AND snapshot.campus_id='a'
          AND snapshot.grade IS NULL AND snapshot.reading_level IS NULL AND snapshot.rule_version='learning-points-v2'
        ORDER BY COALESCE(snapshot.activated_at,snapshot.generated_at) DESC LIMIT 1`,[id,key]);
      return result.rows[0]?.score??'0';
    };
    assert.equal(await periodScore(cohort[0]!,'2026-09'),'10');
    await pool.query(`UPDATE quiz_attempts SET withdrawn_at=now(),withdrawal_reason='smoke withdrawal' WHERE id=$1`,[attempts[0]]);
    assert.equal(await total(cohort[0]!),'0');
    await worker.processAvailable(500);
    assert.equal(await periodScore(cohort[0]!,'2026-09'),'0','withdrawal must refresh original month automatically');
    await quiz(cohort[0]!,oct);assert.equal(await total(cohort[0]!),'10');
    await worker.processAvailable(500);
    assert.equal(await periodScore(cohort[0]!,'2026-09'),'10','later correct answer must refresh original month');
    assert.equal(await periodScore(cohort[0]!,'2026-10'),'0','reactivation must not award a second quiz credit');
    await pool.query(`UPDATE quiz_attempts SET withdrawn_at=now(),withdrawal_reason='restore fixture' WHERE id=$1`,[attempts[1]]);
    await worker.processAvailable(500);
    assert.equal(await periodScore(cohort[1]!,'2026-09'),'0');
    await pool.query(`UPDATE quiz_attempts SET withdrawn_at=NULL,withdrawal_reason=NULL WHERE id=$1`,[attempts[1]]);
    await worker.processAvailable(500);
    assert.equal(await periodScore(cohort[1]!,'2026-09'),'10','identical restored source must reactivate its immutable snapshot');

    const big=await user();
    await pool.query(`INSERT INTO learning_score_events (user_id,piece_id,event_key,kind,points,earned_at,historical)
      VALUES ($1,'points-piece','large-fixture','listening',900719925474099312345678901,$2,true)`,[big,oct]);
    assert.equal(await total(big),'900719925474099312345678901');
    // The down migration must refuse any lossy rollback and keep points intact.
    const rollbackClient=await pool.connect();
    try{await rollbackClient.query('BEGIN');await assert.rejects(rollbackClient.query(migrations.at(-1)!.downSql),/Learning points exist/);await rollbackClient.query('ROLLBACK');}finally{rollbackClient.release();}
    assert.equal(await total(big),'900719925474099312345678901');
    console.log('learning-points.smoke.passed historical=totals-only fractional=ok versions=dedup concurrent=ok quiz=dedup withdrawal=automatic cross-month=automatic bigint=exact rollback=refused');
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
}
main().catch(error=>{console.error(error);process.exitCode=1});
