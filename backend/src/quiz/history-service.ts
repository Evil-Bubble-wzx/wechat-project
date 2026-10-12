import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError } from "../api/errors.ts";
import { readLearningScore, type LearningScoreSummary } from "../ranking/learning-score.ts";

export type QuizHistoryEntry={
  schemaVersion:1;attemptId:string;workId:string;pieceId:string;title:string;
  contentVersion:number;quizVersion:number;startedAt:string;submittedAt:string;verifiedAt:string|null;
  status:"server_verified"|"rejected"|"withdrawn";score:number|null;mastery:boolean|null;
  questionCount:number;correctCount:number;currentCompatible:boolean;rejectionCode:string|null;
  revision:string;serverUpdatedAt:string;
};
export type QuizHistoryPage={schemaVersion:1;serverTime:string;changes:QuizHistoryEntry[];nextCursor:string;hasMore:boolean};
export type QuizTrend={ready:boolean;remaining:number;early:number|null;recent:number|null;delta:number|null;pieceCount:number};
export type LearningSummary={
  schemaVersion:1;source:"server_verified";asOf:string;completedPieces:number;
  completedWords:string|null;knownCompletedWords:string;unknownWordPieces:number;listenedMs:string;
  verifiedAttemptCount:number;compatibleQuizPieces:number;averageCorrectPercent:number|null;
  trend:QuizTrend;learningScore:LearningScoreSummary;
};
export function quizTrend(scores:number[]):QuizTrend{
  const remaining=Math.max(0,6-scores.length);
  if(remaining)return {ready:false,remaining,early:null,recent:null,delta:null,pieceCount:scores.length};
  const size=Math.max(1,Math.floor(scores.length/3));
  const mean=(values:number[])=>Math.round(values.reduce((sum,value)=>sum+value,0)/values.length);
  const early=mean(scores.slice(0,size)),recent=mean(scores.slice(-size));
  return {ready:true,remaining:0,early,recent,delta:recent-early,pieceCount:scores.length};
}
type HistoryRow={
  attempt_id:string;work_id:string;piece_id:string;title:string;content_version:number;quiz_version:number;
  started_at:Date;submitted_at:Date;verified_at:Date|null;status:"server_verified"|"rejected";
  score:number|null;mastery:boolean|null;withdrawn_at:Date|null;rejection_code:string|null;
  history_seq:string;history_updated_at:Date;question_count:number;correct_count:number;compatible:boolean;
};
const compatibleSQL="w.status='published' AND p.status='published' AND w.access_type='free' AND p.access_type='free' AND cv.status='published' AND p.current_content_version_id=cv.id AND qp.status='published' AND qp.quiz_version=(SELECT max(qp2.quiz_version) FROM quiz_packages qp2 WHERE qp2.piece_id=p.id AND qp2.content_version=cv.content_version AND qp2.status='published')";

export class LearningHistoryService{
  private readonly pool:Pool;
  private readonly key:Buffer;
  constructor(pool:Pool,keyBase64:string){
    this.pool=pool;this.key=Buffer.from(keyBase64,"base64");
    if(this.key.length<32)throw new Error("Quiz cursor key must be at least 32 bytes");
  }
  private cursor(userId:string,epoch:string,sequence:string){
    const payload=Buffer.from(JSON.stringify({userId,epoch,sequence})).toString("base64url");
    return payload+"."+createHmac("sha256",this.key).update(payload).digest("base64url");
  }
  private readCursor(userId:string,epoch:string,cursor:string|null){
    if(cursor===null)return "0";
    try{
      const [payload,signature,extra]=cursor.split(".");
      const expected=createHmac("sha256",this.key).update(payload!).digest("base64url");
      if(extra||!signature||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new Error("signature");
      const decoded=JSON.parse(Buffer.from(payload!,"base64url").toString()) as {userId:string;epoch:string;sequence:string};
      if(decoded.userId!==userId||decoded.epoch!==epoch||!/^(0|[1-9][0-9]{0,18})$/.test(decoded.sequence)||BigInt(decoded.sequence)>9223372036854775807n)throw new Error("scope");
      return decoded.sequence;
    }catch{throw new ApiError("INVALID_REQUEST",400,false,"Quiz history cursor is invalid; restart the history pull",{field:"cursor"})}
  }
  private async accountRead<T>(userId:string,read:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",[userId]);
      const result=await read(client);
      await client.query("COMMIT");return result;
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  }
  async history(userId:string,cursor:string|null,limit:number):Promise<QuizHistoryPage>{
    return this.accountRead(userId,async client=>{
      const epoch=(await client.query<{epoch:string}>("SELECT 'quiz_history_change_seq'::regclass::oid::text AS epoch")).rows[0]!.epoch;
      const sequence=this.readCursor(userId,epoch,cursor);
      const serverTime=(await client.query<{at:Date}>("SELECT statement_timestamp() AS at")).rows[0]!.at;
      const sql="SELECT qa.*,qa.history_seq::text,qp.piece_id,qp.content_version,qp.quiz_version,p.work_id,p.title,("+compatibleSQL+") AS compatible,"+
        "(SELECT count(*)::int FROM quiz_questions qq WHERE qq.quiz_package_id=qp.id) AS question_count,"+
        "(SELECT count(*)::int FROM quiz_answers a WHERE a.quiz_attempt_id=qa.id AND a.is_correct) AS correct_count "+
        "FROM quiz_attempts qa JOIN quiz_packages qp ON qp.id=qa.quiz_package_id JOIN pieces p ON p.id=qp.piece_id "+
        "JOIN works w ON w.id=p.work_id JOIN content_versions cv ON cv.piece_id=p.id AND cv.content_version=qp.content_version "+
        "WHERE qa.user_id=$1 AND qa.history_seq>$2 ORDER BY qa.history_seq LIMIT $3";
      const rows=(await client.query<HistoryRow>(sql,[userId,sequence,limit+1])).rows,page=rows.slice(0,limit);
      const changes=page.map(row=>({
        schemaVersion:1 as const,attemptId:row.attempt_id,workId:row.work_id,pieceId:row.piece_id,title:row.title,
        contentVersion:row.content_version,quizVersion:row.quiz_version,startedAt:row.started_at.toISOString(),
        submittedAt:row.submitted_at.toISOString(),verifiedAt:row.verified_at?.toISOString()??null,
        status:row.withdrawn_at?"withdrawn" as const:row.status,
        score:row.withdrawn_at?null:row.score,mastery:row.withdrawn_at?null:row.mastery,
        questionCount:row.question_count,correctCount:row.correct_count,currentCompatible:row.compatible,
        rejectionCode:row.rejection_code,revision:row.history_seq,serverUpdatedAt:row.history_updated_at.toISOString(),
      }));
      return {schemaVersion:1,serverTime:serverTime.toISOString(),changes,nextCursor:this.cursor(userId,epoch,page.at(-1)?.history_seq??sequence),hasMore:rows.length>limit};
    });
  }
  async summary(userId:string):Promise<LearningSummary>{
    return this.accountRead(userId,async client=>{
      // One statement fixes content compatibility and all aggregate facts together.
      const sql="WITH completion_words AS (SELECT CASE WHEN (cv.catalog_metadata->>'wordCount')~'^[0-9]+$' THEN (cv.catalog_metadata->>'wordCount')::numeric "+
        "WHEN cv.catalog_metadata='{}'::jsonb THEN p.word_count::numeric ELSE NULL END AS words "+
        "FROM learning_score_events e JOIN pieces p ON p.id=e.piece_id LEFT JOIN content_versions cv ON cv.piece_id=e.piece_id "+
        "AND cv.content_version=(e.details->>'contentVersion')::int WHERE e.user_id=$1 AND e.kind='completion'),"+
        "heard AS (SELECT piece_id,max(listened_ms)::numeric AS ms FROM user_learning_progress WHERE user_id=$1 GROUP BY piece_id),"+
        "latest AS (SELECT DISTINCT ON(qp.piece_id) qp.piece_id,qa.score,qa.verified_at,qa.id FROM quiz_attempts qa "+
        "JOIN quiz_packages qp ON qp.id=qa.quiz_package_id JOIN pieces p ON p.id=qp.piece_id JOIN works w ON w.id=p.work_id "+
        "JOIN content_versions cv ON cv.piece_id=p.id AND cv.content_version=qp.content_version "+
        "WHERE qa.user_id=$1 AND qa.status='server_verified' AND qa.withdrawn_at IS NULL AND "+compatibleSQL+" ORDER BY qp.piece_id,qa.verified_at DESC,qa.id DESC) "+
        "SELECT statement_timestamp() AS at,(SELECT count(*)::int FROM completion_words) AS completed,"+
        "(SELECT count(*)::int FROM completion_words WHERE words IS NULL) AS unknown_words,"+
        "(SELECT coalesce(sum(words),0)::text FROM completion_words) AS known_words,"+
        "(SELECT coalesce(sum(ms),0)::text FROM heard) AS listened_ms,"+
        "(SELECT count(*)::int FROM quiz_attempts WHERE user_id=$1 AND status='server_verified' AND withdrawn_at IS NULL) AS verified_count,"+
        "(SELECT coalesce(jsonb_agg(score ORDER BY verified_at,id),'[]'::jsonb) FROM latest) AS scores";
      const row=(await client.query<{at:Date;completed:number;unknown_words:number;known_words:string;listened_ms:string;verified_count:number;scores:number[]}>(sql,[userId])).rows[0]!;
      return {schemaVersion:1,source:"server_verified",asOf:row.at.toISOString(),completedPieces:row.completed,
        completedWords:row.unknown_words?null:row.known_words,knownCompletedWords:row.known_words,unknownWordPieces:row.unknown_words,
        listenedMs:row.listened_ms,verifiedAttemptCount:row.verified_count,compatibleQuizPieces:row.scores.length,
        averageCorrectPercent:row.scores.length?Math.round(row.scores.reduce((sum,value)=>sum+value,0)/row.scores.length):null,
        trend:quizTrend(row.scores),learningScore:await readLearningScore(client,userId)};
    });
  }
}
