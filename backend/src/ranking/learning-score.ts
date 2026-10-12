import type { Pool, PoolClient } from "pg";
import { RANKING_RULE_VERSION, scoreLearningEvents, type LearningScoreFact } from "./score.ts";
export type LearningScoreSummary = { ruleVersion:typeof RANKING_RULE_VERSION; totalPoints:string; breakdown:ReturnType<typeof scoreLearningEvents>["breakdown"]; asOf:string };
export async function readLearningScore(query:Pool|PoolClient,userId:string):Promise<LearningScoreSummary> {
  const ownTransaction=!("release" in query);
  const client=ownTransaction?await (query as Pool).connect():query as PoolClient;
  try{
    if(ownTransaction)await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",[userId]);
    const rows=await client.query<{events:Array<{kind:LearningScoreFact["kind"];points:string}>;as_of:Date}>(
      `SELECT coalesce(jsonb_agg(totals),'[]'::jsonb) AS events,statement_timestamp() AS as_of
       FROM (SELECT kind,sum(points)::text AS points FROM valid_learning_score_events WHERE user_id=$1 GROUP BY kind) totals`,[userId]);
    const value=scoreLearningEvents(rows.rows[0]!.events.map(row=>({id:row.kind,kind:row.kind,points:row.points})));
    const summary:LearningScoreSummary={ruleVersion:RANKING_RULE_VERSION,totalPoints:value.score,breakdown:value.breakdown,asOf:rows.rows[0]!.as_of.toISOString()};
    if(ownTransaction)await client.query("COMMIT");
    return summary;
  }catch(error){if(ownTransaction)await client.query("ROLLBACK");throw error}
  finally{if(ownTransaction)client.release()}
}
