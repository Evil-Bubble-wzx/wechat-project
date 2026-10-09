import type { Pool, PoolClient } from "pg";
import { RANKING_RULE_VERSION, scoreLearningEvents, type LearningScoreFact } from "./score.ts";
export type LearningScoreSummary = { ruleVersion:typeof RANKING_RULE_VERSION; totalPoints:string; breakdown:ReturnType<typeof scoreLearningEvents>["breakdown"]; asOf:string };
export async function readLearningScore(query:Pick<Pool|PoolClient,"query">,userId:string):Promise<LearningScoreSummary> {
  const rows=await query.query<{kind:LearningScoreFact["kind"];points:string}>(
    "SELECT kind,sum(points)::text AS points FROM valid_learning_score_events WHERE user_id=$1 GROUP BY kind",[userId]);
  const value=scoreLearningEvents(rows.rows.map(row=>({id:row.kind,kind:row.kind,points:row.points})));
  return {ruleVersion:RANKING_RULE_VERSION,totalPoints:value.score,breakdown:value.breakdown,asOf:new Date().toISOString()};
}
