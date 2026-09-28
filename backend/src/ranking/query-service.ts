import type { Pool } from "pg";

import { ApiError } from "../api/errors.ts";
import { decodeKey, hmacSha256 } from "../security/crypto.ts";
import { RANKING_RULE_VERSION, type RankingScoreBreakdown } from "./score.ts";
import type { RankingPeriodType } from "./aggregation-service.ts";

export const RANKING_TIMEZONE = "Asia/Shanghai";
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const gradeValues = ["k", ...Array.from({length:9},(_,index)=>String(index+1))];
const levelValues = Array.from({length:5},(_,index)=>String(index+1));

type RankingFilters = {
  campusId: string;
  periodType: RankingPeriodType;
  periodKey?: string;
  grade?: string;
  level?: string;
};

type SnapshotRow = {
  id: string;
  period_type: RankingPeriodType;
  period_key: string;
  starts_at: Date;
  ends_at: Date;
  rule_version: string;
  result_status: "ready" | "cohort_too_small" | "unavailable" | null;
  cohort_size: number;
  minimum_cohort_size: number;
  generated_at: Date | null;
};

type CursorPayload =
  | { type:"ranking"; snapshotId:string; rank:number; participantId:string }
  | { type:"quizzes"; snapshotId:string; takenAt:string; attemptId:string };

const pad2=(value:number)=>String(value).padStart(2,"0");
const iso=(date:Date)=>date.toISOString();
export const shanghaiDate=(date:Date)=>new Date(date.getTime()+SHANGHAI_OFFSET_MS);
const fromShanghaiParts=(year:number,month:number,day:number,hour=0)=>new Date(Date.UTC(year,month-1,day,hour)-SHANGHAI_OFFSET_MS);
const dateKey=(date:Date)=>{
  const local=shanghaiDate(date);
  return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth()+1)}-${pad2(local.getUTCDate())}`;
};

export function isoWeek(date:Date):{year:number;week:number}{
  const local=shanghaiDate(date);
  const target=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()));
  const day=target.getUTCDay()||7;
  target.setUTCDate(target.getUTCDate()+4-day);
  const year=target.getUTCFullYear();
  return {year,week:Math.ceil((((target.getTime()-Date.UTC(year,0,1))/86400000)+1)/7)};
}

export function weekWindow(key:string):{startsAt:Date;endsAt:Date}{
  const match=/^(\d{4})-W(\d{2})$/.exec(key);
  if(!match)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Week key must use YYYY-Www");
  const year=Number(match[1]),week=Number(match[2]);
  if(week<1||week>53)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Week number is invalid");
  const january4=new Date(Date.UTC(year,0,4));
  const january4Day=january4.getUTCDay()||7;
  const mondayUtc=new Date(Date.UTC(year,0,4-(january4Day-1)+(week-1)*7));
  const startsAt=fromShanghaiParts(mondayUtc.getUTCFullYear(),mondayUtc.getUTCMonth()+1,mondayUtc.getUTCDate());
  const normalized=isoWeek(startsAt);
  if(normalized.year!==year||normalized.week!==week)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Week number is invalid");
  return {startsAt,endsAt:new Date(startsAt.getTime()+7*86400000)};
}

export function monthWindow(key:string):{startsAt:Date;endsAt:Date}{
  const match=/^(\d{4})-(\d{2})$/.exec(key);
  if(!match)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Month key must use YYYY-MM");
  const year=Number(match[1]),month=Number(match[2]);
  if(month<1||month>12)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Month number is invalid");
  return {startsAt:fromShanghaiParts(year,month,1),endsAt:fromShanghaiParts(month===12?year+1:year,month===12?1:month+1,1)};
}

export function yearWindow(key:string):{startsAt:Date;endsAt:Date}{
  if(!/^\d{4}$/.test(key))throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Year key must use YYYY");
  const year=Number(key);
  return {startsAt:fromShanghaiParts(year,1,1),endsAt:fromShanghaiParts(year+1,1,1)};
}

function gradeLabel(value:string|null):string|null{return value===null?null:value==="k"?"Kindergarten":`Grade ${value}`}
function levelLabel(value:string|null):string|null{return value===null?null:`Lv ${value}.x`}

export class RankingQueryService{
  private readonly pool:Pool;
  private readonly cursorKey:Buffer;
  private readonly now:()=>Date;

  constructor(pool:Pool,cursorKeyBase64:string,now:()=>Date=()=>new Date()){
    this.pool=pool;
    this.cursorKey=decodeKey(cursorKeyBase64);
    this.now=now;
  }

  private encodeCursor(payload:CursorPayload):string{
    const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${hmacSha256(encoded,this.cursorKey)}`;
  }

  private decodeCursor(cursor:string|undefined,expectedType:CursorPayload["type"]):CursorPayload|null{
    if(!cursor)return null;
    const [payload,signature,extra]=cursor.split(".");
    if(!payload||!signature||extra||hmacSha256(payload,this.cursorKey)!==signature)throw new ApiError("INVALID_REQUEST",400,false,"Cursor is invalid");
    try{
      const decoded=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as CursorPayload;
      if(decoded.type!==expectedType||typeof decoded.snapshotId!=="string")throw new Error("scope");
      return decoded;
    }catch{throw new ApiError("INVALID_REQUEST",400,false,"Cursor is invalid")}
  }

  private validateFilters(input:RankingFilters):{campusId:string;periodType:RankingPeriodType;periodKey:string|undefined;grade:string|null;level:string|null;window:{startsAt:Date;endsAt:Date;periodKey:string}}{
    if(!["rolling7","week","month","year"].includes(input.periodType))throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Ranking period type is invalid");
    if(!/^[a-z][a-z0-9-]{0,31}$/.test(input.campusId))throw new ApiError("RANKING_FILTER_INVALID",400,false,"Campus is invalid");
    const grade=!input.grade||input.grade==="all"?null:input.grade.toLowerCase();
    const level=!input.level||input.level==="all"?null:input.level;
    if(grade!==null&&!gradeValues.includes(grade))throw new ApiError("RANKING_FILTER_INVALID",400,false,"Grade is invalid");
    if(level!==null&&!levelValues.includes(level))throw new ApiError("RANKING_FILTER_INVALID",400,false,"Reading level is invalid");
    const now=this.now();
    let window:{startsAt:Date;endsAt:Date;periodKey:string};
    if(input.periodType==="rolling7"){
      if(input.periodKey)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"rolling7 does not accept periodKey");
      const endsAt=now,startsAt=new Date(now.getTime()-7*86400000);
      window={startsAt,endsAt,periodKey:`${dateKey(startsAt)}/${dateKey(endsAt)}`};
    }else if(input.periodType==="week"){
      if(!input.periodKey)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Week periodKey is required");
      window={...weekWindow(input.periodKey),periodKey:input.periodKey};
    }else if(input.periodType==="month"){
      if(!input.periodKey)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Month periodKey is required");
      window={...monthWindow(input.periodKey),periodKey:input.periodKey};
    }else{
      const local=shanghaiDate(now),key=input.periodKey??String(local.getUTCFullYear());
      window={...yearWindow(key),periodKey:key};
    }
    if(window.startsAt>now)throw new ApiError("RANKING_PERIOD_INVALID",400,false,"Future ranking periods are unavailable");
    return {campusId:input.campusId,periodType:input.periodType,periodKey:input.periodType==="rolling7"?undefined:window.periodKey,grade,level,window};
  }

  async options(){
    const campuses=(await this.pool.query<{id:string;display_name:string}>("SELECT id,display_name FROM campuses WHERE status='active' ORDER BY id")).rows.map(row=>({value:row.id,label:row.display_name}));
    const now=this.now();
    const currentWeek=weekWindow(`${isoWeek(now).year}-W${pad2(isoWeek(now).week)}`).startsAt;
    const weeks=Array.from({length:12},(_,index)=>{
      const startsAt=new Date(currentWeek.getTime()-index*7*86400000),endsAt=new Date(startsAt.getTime()+7*86400000),value=isoWeek(startsAt);
      return {key:`${value.year}-W${pad2(value.week)}`,label:`${value.year}年第${value.week}周`,startsAt:iso(startsAt),endsAt:iso(endsAt)};
    });
    const local=shanghaiDate(now);
    const months=Array.from({length:12},(_,index)=>{
      const date=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()-index,1)),year=date.getUTCFullYear(),month=date.getUTCMonth()+1,window=monthWindow(`${year}-${pad2(month)}`);
      return {key:`${year}-${pad2(month)}`,label:`${year}年${month}月`,startsAt:iso(window.startsAt),endsAt:iso(window.endsAt)};
    });
    return {timezone:RANKING_TIMEZONE,minimumCohortSize:10,ruleVersion:RANKING_RULE_VERSION,campuses,periodTypes:[{value:"rolling7",label:"最近七天",requiresPeriodSelection:false},{value:"week",label:"周榜",requiresPeriodSelection:true},{value:"month",label:"月榜",requiresPeriodSelection:true},{value:"year",label:"年榜",requiresPeriodSelection:false}],periods:{week:weeks,month:months},grades:[{value:"all",label:"全部年级"},{value:"k",label:"幼儿园"},...Array.from({length:9},(_,index)=>({value:String(index+1),label:`${index+1}年级`}))],levels:[{value:"all",label:"全部级别"},...Array.from({length:5},(_,index)=>({value:String(index+1),label:`Lv ${index+1}.x`}))]};
  }

  private async assertActiveCampus(campusId:string):Promise<void>{
    const result=await this.pool.query<{exists:boolean}>(
      "SELECT EXISTS (SELECT 1 FROM campuses WHERE id=$1 AND status='active') AS exists",
      [campusId],
    );
    if(!result.rows[0]?.exists)throw new ApiError("RANKING_FILTER_INVALID",400,false,"Campus is invalid");
  }

  private async snapshot(filters:ReturnType<RankingQueryService["validateFilters"]>,snapshotId?:string):Promise<SnapshotRow|null>{
    const result=await this.pool.query<SnapshotRow>(
      `SELECT id,period_type,period_key,starts_at,ends_at,rule_version,result_status,
              cohort_size,minimum_cohort_size,generated_at
       FROM ranking_snapshots
       WHERE status='ready' AND campus_id=$1 AND period_type=$2
         AND grade IS NOT DISTINCT FROM $3 AND reading_level IS NOT DISTINCT FROM $4
         AND rule_version=$5 AND ($6::text IS NULL OR period_key=$6)
         AND ($7::uuid IS NULL OR id=$7)
       ORDER BY generated_at DESC LIMIT 1`,
      [filters.campusId,filters.periodType,filters.grade,filters.level,RANKING_RULE_VERSION,filters.periodKey,snapshotId??null],
    );
    return result.rows[0]??null;
  }

  async rankings(userId:string,input:RankingFilters,cursor:string|undefined,limit:number){
    const filters=this.validateFilters(input);
    await this.assertActiveCampus(filters.campusId);
    const after=this.decodeCursor(cursor,"ranking") as Extract<CursorPayload,{type:"ranking"}>|null;
    const snapshot=await this.snapshot(filters,after?.snapshotId);
    const normalizedFilters={campusId:filters.campusId,periodType:filters.periodType,periodKey:snapshot?.period_key??filters.window.periodKey,grade:filters.grade,level:filters.level};
    if(!snapshot)return {status:"unavailable" as const,timezone:RANKING_TIMEZONE,filters:normalizedFilters,ruleVersion:RANKING_RULE_VERSION,periodType:filters.periodType,periodKey:normalizedFilters.periodKey,startsAt:iso(filters.window.startsAt),endsAt:iso(filters.window.endsAt),generatedAt:null,minimumCohortSize:10,cohortSize:0,items:[],currentUser:null,nextCursor:null};
    if(snapshot.result_status!=="ready")return {status:snapshot.result_status??"unavailable",timezone:RANKING_TIMEZONE,filters:normalizedFilters,ruleVersion:snapshot.rule_version,periodType:snapshot.period_type,periodKey:snapshot.period_key,startsAt:iso(snapshot.starts_at),endsAt:iso(snapshot.ends_at),generatedAt:snapshot.generated_at?.toISOString()??null,minimumCohortSize:snapshot.minimum_cohort_size,cohortSize:snapshot.cohort_size,items:[],currentUser:null,nextCursor:null};
    const rows=await this.pool.query<{rank:number;participant_id:string;display_name:string;score:number;profile_grade:string|null;profile_reading_level:string|null}>(
      `SELECT rank,participant_id,display_name,score,profile_grade,profile_reading_level FROM ranking_snapshot_entries
       WHERE snapshot_id=$1 AND ($2::integer IS NULL OR rank>$2 OR (rank=$2 AND participant_id>$3))
       ORDER BY rank,participant_id LIMIT $4`,[snapshot.id,after?.rank??null,after?.participantId??null,limit+1]);
    const page=rows.rows.slice(0,limit),hasMore=rows.rows.length>limit;
    const mapEntry=(row:{rank:number;participant_id:string;display_name:string;score:number;profile_grade:string|null;profile_reading_level:string|null})=>({rank:row.rank,participantId:row.participant_id,displayName:row.display_name,gradeLabel:gradeLabel(row.profile_grade),readingLevelLabel:levelLabel(row.profile_reading_level),metric:{key:"rankingScore" as const,label:"Quiz Score" as const,value:row.score,unit:"points" as const}});
    const current=(await this.pool.query<{rank:number;participant_id:string;display_name:string;score:number;profile_grade:string|null;profile_reading_level:string|null}>("SELECT rank,participant_id,display_name,score,profile_grade,profile_reading_level FROM ranking_snapshot_entries WHERE snapshot_id=$1 AND user_id=$2",[snapshot.id,userId])).rows[0];
    const last=page.at(-1);
    return {status:"ready" as const,timezone:RANKING_TIMEZONE,filters:normalizedFilters,ruleVersion:snapshot.rule_version,periodType:snapshot.period_type,periodKey:snapshot.period_key,startsAt:iso(snapshot.starts_at),endsAt:iso(snapshot.ends_at),generatedAt:snapshot.generated_at!.toISOString(),minimumCohortSize:snapshot.minimum_cohort_size,cohortSize:snapshot.cohort_size,items:page.map(mapEntry),currentUser:current?mapEntry(current):null,nextCursor:hasMore&&last?this.encodeCursor({type:"ranking",snapshotId:snapshot.id,rank:last.rank,participantId:last.participant_id}):null};
  }

  async detail(input:RankingFilters,participantId:string,cursor:string|undefined,limit:number){
    const filters=this.validateFilters(input);
    await this.assertActiveCampus(filters.campusId);
    const after=this.decodeCursor(cursor,"quizzes") as Extract<CursorPayload,{type:"quizzes"}>|null;
    const snapshot=await this.snapshot(filters,after?.snapshotId);
    if(!snapshot||snapshot.result_status!=="ready")throw new ApiError("RANKING_UNAVAILABLE",503,true,"Ranking snapshot is unavailable");
    const entry=(await this.pool.query<{user_id:string;display_name:string;score:number;score_breakdown:RankingScoreBreakdown[];stats:Record<string,number|null>;profile_grade:string|null;profile_reading_level:string|null}>("SELECT user_id,display_name,score,score_breakdown,stats,profile_grade,profile_reading_level FROM ranking_snapshot_entries WHERE snapshot_id=$1 AND participant_id=$2",[snapshot.id,participantId])).rows[0];
    if(!entry)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Ranking participant is unavailable");
    const rows=await this.pool.query<{quiz_attempt_id:string;work_id:string;piece_id:string;title:string;series:string|null;author:string|null;taken_at:Date;correct_percent:string;level:string|null;category:"fiction"|"nonfiction"|null;word_count:number}>(
      `SELECT quiz_attempt_id,work_id,piece_id,title,series,author,taken_at,correct_percent,level,category,word_count
       FROM ranking_snapshot_quizzes WHERE snapshot_id=$1 AND user_id=$2
         AND ($3::timestamptz IS NULL OR taken_at<$3 OR (taken_at=$3 AND quiz_attempt_id::text>$4))
       ORDER BY taken_at DESC,quiz_attempt_id LIMIT $5`,[snapshot.id,entry.user_id,after?.takenAt??null,after?.attemptId??null,limit+1]);
    const page=rows.rows.slice(0,limit),hasMore=rows.rows.length>limit,last=page.at(-1);
    return {ruleVersion:snapshot.rule_version,participant:{participantId,displayName:entry.display_name,gradeLabel:gradeLabel(entry.profile_grade),readingLevelLabel:levelLabel(entry.profile_reading_level)},periodType:snapshot.period_type,periodKey:snapshot.period_key,startsAt:iso(snapshot.starts_at),endsAt:iso(snapshot.ends_at),rankingScore:entry.score,scoreBreakdown:entry.score_breakdown,stats:entry.stats,quizzes:page.map(row=>({attemptId:row.quiz_attempt_id,workId:row.work_id,pieceId:row.piece_id,title:row.title,series:row.series,author:row.author,takenAt:row.taken_at.toISOString(),correctPercent:Number(row.correct_percent),level:row.level===null?null:Number(row.level),category:row.category,wordCount:row.word_count,completed:true as const})),nextCursor:hasMore&&last?this.encodeCursor({type:"quizzes",snapshotId:snapshot.id,takenAt:last.taken_at.toISOString(),attemptId:last.quiz_attempt_id}):null};
  }
}
