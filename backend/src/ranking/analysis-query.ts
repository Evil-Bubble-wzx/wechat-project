import type {Pool} from "pg";
import {ApiError} from "../api/errors.ts";
import {hmacSha256} from "../security/crypto.ts";
export const analysisSorts=["date","title","accuracy","level","words","quizPoints"] as const;
export type AnalysisOptions={query?:string;sort?:string;direction?:string};
export function normalizeAnalysis(input:AnalysisOptions={}){
  if(input.query!==undefined&&typeof input.query!=="string"||input.query&&input.query.length>128)throw new ApiError("INVALID_REQUEST",400,false,"Search must be at most 128 characters");
  const sort=input.sort??"date",direction=input.direction??"desc",query=(input.query??"").trim();
  if(!analysisSorts.includes(sort as any)||!["asc","desc"].includes(direction))throw new ApiError("INVALID_REQUEST",400,false,"Sort is invalid");
  return {query,sort,direction};
}
type AnalysisCursor={type:"quiz-analysis";snapshotId:string;participantId:string;query:string;sort:string;direction:string;offset:number};
export async function readAnalysis(pool:Pool,key:Buffer,snapshot:{id:string;rule_version:string;period_type:string;period_key:string;starts_at:Date;ends_at:Date},participantId:string,cursor:string|undefined,limit:number,input:AnalysisOptions){
  const options=normalizeAnalysis(input),scope={type:"quiz-analysis",snapshotId:snapshot.id,participantId,...options};
  let offset=0;
  if(cursor){
    const [payload,signature,extra]=cursor.split(".");
    if(!payload||!signature||extra||hmacSha256(payload,key)!==signature)throw new ApiError("INVALID_REQUEST",400,false,"Cursor is invalid");
    try{
      const value=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as AnalysisCursor;
      if(Object.entries(scope).some(([k,v])=>(value as any)[k]!==v)||!Number.isInteger(value.offset)||value.offset<0||value.offset>1000000)throw new Error("scope");
      offset=value.offset;
    }catch{throw new ApiError("INVALID_REQUEST",400,false,"Cursor does not match participant, snapshot or search and sort")}
  }
  const entry=(await pool.query("SELECT user_id,display_name,score,score_breakdown,quiz_analysis,profile_grade,profile_reading_level FROM ranking_snapshot_entries WHERE snapshot_id=$1 AND participant_id=$2",[snapshot.id,participantId])).rows[0];
  if(!entry)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Participant is unavailable");
  if(!entry.quiz_analysis)throw new ApiError("RANKING_UNAVAILABLE",503,true,"Legacy snapshot has no verified analysis; refresh the ranking");
  const order=({date:"verified_at",title:"title",accuracy:"correct_percent",level:"level",words:"CASE WHEN word_count_known THEN word_count END",quizPoints:"quiz_points"} as Record<string,string>)[options.sort]!;
  const pattern="%"+options.query.replace(/[\\%_]/g,char=>"\\"+char)+"%";
  const where="FROM ranking_snapshot_quizzes WHERE snapshot_id=$1 AND user_id=$2 AND concat_ws(' ',title,series,author,work_id,piece_id) ILIKE $3 ESCAPE '\\'";
  const total=Number((await pool.query("SELECT count(*)::integer AS total "+where,[snapshot.id,entry.user_id,pattern])).rows[0]!.total);
  const rows=(await pool.query("SELECT quiz_attempt_id,work_id,piece_id,title,series,author,verified_at,correct_percent,level,category,word_count,word_count_known,passed,content_version,quiz_points::text "+where+" ORDER BY "+order+" "+options.direction+" NULLS LAST,quiz_attempt_id ASC LIMIT $4 OFFSET $5",[snapshot.id,entry.user_id,pattern,limit+1,offset])).rows;
  const items=rows.slice(0,limit).map(row=>({
    attemptId:row.quiz_attempt_id,workId:row.work_id,pieceId:row.piece_id,title:row.title,series:row.series,author:row.author,
    takenAt:row.verified_at.toISOString(),correctPercent:Number(row.correct_percent),level:row.level===null?null:Number(row.level),
    category:row.category,wordCount:row.word_count_known?row.word_count:null,passed:row.passed,contentVersion:row.content_version,quizPoints:String(row.quiz_points)
  }));
  const next=rows.length>limit?Buffer.from(JSON.stringify({...scope,offset:offset+limit})).toString("base64url"):null;
  return {
    snapshotId:snapshot.id,ruleVersion:snapshot.rule_version,participant:{participantId,displayName:entry.display_name,
      gradeLabel:entry.profile_grade===null?null:entry.profile_grade==="k"?"Kindergarten":"Grade "+entry.profile_grade,
      readingLevelLabel:entry.profile_reading_level===null?null:"Lv "+entry.profile_reading_level+".x"},
    periodType:snapshot.period_type,periodKey:snapshot.period_key,startsAt:snapshot.starts_at.toISOString(),endsAt:snapshot.ends_at.toISOString(),
    rankingScore:String(entry.score),scoreBreakdown:entry.score_breakdown,stats:entry.quiz_analysis,search:options,totalMatches:total,quizzes:items,
    nextCursor:next?next+"."+hmacSha256(next,key):null
  };
}
