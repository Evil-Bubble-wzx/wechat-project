import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { QuizAttemptInput, QuizService } from "../quiz/service.ts";
import { ApiError } from "../api/errors.ts";

export type LocalProgressInput={pieceId:string;contentVersion:number;durationMs:number;checkpointMs:number;listenedRangesMs:Array<[number,number]>;updatedAt:string};
export type LocalImportInput={snapshotId:string;payload:{schemaVersion:1;progress:LocalProgressInput[];words:Array<{surface:string}>;quizAttempts:QuizAttemptInput[]};limitations:{words:"surface_only"}};
export type LocalImportResponse={snapshotId:string;status:"completed";duplicate:boolean;summary:{progress:{accepted:number;unchanged:number;rejected:number};words:{pending:number;reused:number;rejected:number};quizAttempts:{verified:number;rejected:number}};items:{progress:Array<Record<string,unknown>>;words:Array<Record<string,unknown>>;quizAttempts:Array<Record<string,unknown>>};acknowledgedAt:string};

function canonical(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.keys(value as Record<string,unknown>).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const snapshotFor=(payload:LocalImportInput["payload"])=>`s01-v1:${hash(payload)}`;

function mergeRanges(input:Array<[number,number]>,duration:number):Array<[number,number]>{
  const sorted=input.map(range=>[range[0],range[1]] as [number,number]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const output:Array<[number,number]>=[];
  for(const range of sorted){const previous=output.at(-1);if(previous&&range[0]<=previous[1]+50)previous[1]=Math.max(previous[1],range[1]);else output.push(range)}
  const bounded:Array<[number,number]>=[];
  for(const [start,end] of output){const range:[number,number]=[Math.max(0,start),Math.min(duration,end)];if(range[1]>range[0])bounded.push(range)}
  return bounded;
}
function derived(ranges:Array<[number,number]>,duration:number){
  const listenedMs=Math.min(duration,ranges.reduce((total,[start,end])=>total+end-start,0));
  const coverage=duration?listenedMs/duration:0;
  const tailStart=Math.max(0,duration-3000);
  const tailCovered=ranges.some(([start,end])=>start<=tailStart+50&&end>=duration-250);
  return {listenedMs,coverage,completed:coverage>=0.9&&tailCovered};
}

export class LocalImportService{
  private readonly pool:Pool;
  private readonly quiz:QuizService;
  constructor(pool:Pool,quiz:QuizService){this.pool=pool;this.quiz=quiz}

  async import(userId:string,input:LocalImportInput):Promise<LocalImportResponse>{
    if(snapshotFor(input.payload)!==input.snapshotId)throw new ApiError("INVALID_REQUEST",400,false,"snapshotId does not match the canonical payload");
    const requestHash=hash(input),client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.learning_points_backfill','true',true)");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`local-import:${userId}:${input.snapshotId}`]);
      const existing=await client.query<{request_hash:string;status:string;response:LocalImportResponse|null}>("SELECT request_hash,status,response FROM local_import_snapshots WHERE user_id=$1 AND snapshot_id=$2",[userId,input.snapshotId]);
      if(existing.rows[0]){
        const row=existing.rows[0];
        if(row.request_hash.trim()!==requestHash)throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"snapshotId was already used with a different request");
        if(row.status==="completed"&&row.response){await client.query("COMMIT");return {...row.response,duplicate:true}}
        throw new ApiError("CONFLICT",409,true,"Local import is already processing");
      }
      await client.query("INSERT INTO local_import_snapshots (user_id,snapshot_id,request_hash,status) VALUES ($1,$2,$3,'processing')",[userId,input.snapshotId,requestHash]);
      const progress=[] as Array<Record<string,unknown>>;
      for(const item of input.payload.progress)progress.push(await this.importProgress(client,userId,input.snapshotId,item));
      const words=[] as Array<Record<string,unknown>>;
      for(const item of input.payload.words){
        const result=await client.query<{inserted:boolean}>(`INSERT INTO user_saved_word_candidates (user_id,surface,first_snapshot_id,last_snapshot_id) VALUES ($1,$2,$3,$3) ON CONFLICT (user_id,surface) DO UPDATE SET last_snapshot_id=EXCLUDED.last_snapshot_id RETURNING (xmax=0) AS inserted`,[userId,item.surface,input.snapshotId]);
        words.push({surface:item.surface,status:result.rows[0]?.inserted?"pending_resolution":"reused_pending_candidate"});
      }
      const quizAttempts=[] as Array<Record<string,unknown>>;
      for(const attempt of input.payload.quizAttempts){
        const result=await this.quiz.submit(userId,attempt,{historical:true});
        quizAttempts.push(result.status==="server_verified"?{attemptId:result.attemptId,status:"server_verified",score:result.score,mastery:result.mastery,verifiedAt:result.verifiedAt}:{attemptId:result.attemptId,status:"rejected",reason:result.error.code});
      }
      const count=(items:Array<Record<string,unknown>>,status:string)=>items.filter(item=>item.status===status).length;
      const response:LocalImportResponse={snapshotId:input.snapshotId,status:"completed",duplicate:false,summary:{progress:{accepted:count(progress,"accepted"),unchanged:count(progress,"unchanged"),rejected:count(progress,"rejected")},words:{pending:count(words,"pending_resolution"),reused:count(words,"reused_pending_candidate"),rejected:count(words,"rejected")},quizAttempts:{verified:count(quizAttempts,"server_verified"),rejected:count(quizAttempts,"rejected")}},items:{progress,words,quizAttempts},acknowledgedAt:new Date().toISOString()};
      await client.query("UPDATE local_import_snapshots SET status='completed',response=$3,completed_at=now() WHERE user_id=$1 AND snapshot_id=$2",[userId,input.snapshotId,JSON.stringify(response)]);
      await client.query("COMMIT");
      return response;
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  }

  private async importProgress(client:PoolClient,userId:string,snapshotId:string,item:LocalProgressInput):Promise<Record<string,unknown>>{
    const resource=await client.query<{duration_ms:string|null}>(`SELECT asset.duration_ms::text FROM pieces p JOIN content_versions cv ON cv.id=p.current_content_version_id LEFT JOIN content_assets asset ON asset.piece_id=p.id AND asset.content_version=cv.content_version AND asset.asset_type='audio' AND asset.status IN ('ready','published') WHERE p.id=$1 AND cv.content_version=$2 AND p.status='published' AND cv.status='published'`,[item.pieceId,item.contentVersion]);
    const serverDuration=resource.rows[0]?.duration_ms===null?null:Number(resource.rows[0]?.duration_ms);
    if(!serverDuration||Math.abs(serverDuration-item.durationMs)>500)return {pieceId:item.pieceId,status:"rejected",reason:serverDuration?"duration_mismatch":"content_version_unavailable"};
    const current=await client.query<{content_version:number;checkpoint_ms:number;listened_ranges_ms:Array<[number,number]>;source_updated_at:Date}>("SELECT content_version,checkpoint_ms,listened_ranges_ms,source_updated_at FROM user_learning_progress WHERE user_id=$1 AND piece_id=$2 AND content_version=$3",[userId,item.pieceId,item.contentVersion]);
    const incomingAt=new Date(item.updatedAt),previous=current.rows[0];
    if(previous&&previous.source_updated_at>incomingAt)return {pieceId:item.pieceId,status:"unchanged",reason:"server_has_newer_progress"};
    const ranges=mergeRanges([...(previous?.content_version===item.contentVersion?previous.listened_ranges_ms:[]),...item.listenedRangesMs],serverDuration);
    const checkpoint=Math.min(serverDuration,Math.max(item.checkpointMs,previous?.content_version===item.contentVersion?previous.checkpoint_ms:0));
    const facts=derived(ranges,serverDuration);
    await client.query(`INSERT INTO user_learning_progress (user_id,piece_id,content_version,duration_ms,checkpoint_ms,listened_ranges_ms,listened_ms,coverage,completed,source_updated_at,source_snapshot_id,revision,server_updated_at,last_mutation_id,historical) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,now(),$11,false) ON CONFLICT (user_id,piece_id,content_version) DO UPDATE SET duration_ms=EXCLUDED.duration_ms,checkpoint_ms=EXCLUDED.checkpoint_ms,listened_ranges_ms=EXCLUDED.listened_ranges_ms,listened_ms=EXCLUDED.listened_ms,coverage=EXCLUDED.coverage,completed=user_learning_progress.completed OR EXCLUDED.completed,source_updated_at=EXCLUDED.source_updated_at,imported_at=now(),source_snapshot_id=EXCLUDED.source_snapshot_id,revision=user_learning_progress.revision+1,server_updated_at=now(),last_mutation_id=EXCLUDED.last_mutation_id`,[userId,item.pieceId,item.contentVersion,serverDuration,checkpoint,JSON.stringify(ranges),facts.listenedMs,facts.coverage,facts.completed,incomingAt,snapshotId]);
    return {pieceId:item.pieceId,status:"accepted",coverage:Number(facts.coverage.toFixed(6)),completed:facts.completed};
  }
}

export const localImportCanonical={canonical,hash,snapshotFor};
