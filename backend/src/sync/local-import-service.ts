import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { QuizAttemptInput, QuizService } from "../quiz/service.ts";
import { ApiError } from "../api/errors.ts";
import { deriveProgressFacts, mergeRangesMs, type MillisecondRange } from "./progress-state.ts";

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

export class LocalImportService{
  private readonly pool:Pool;
  private readonly quiz:QuizService;
  constructor(pool:Pool,quiz:QuizService){this.pool=pool;this.quiz=quiz}

  async import(userId:string,input:LocalImportInput):Promise<LocalImportResponse>{
    if(snapshotFor(input.payload)!==input.snapshotId)throw new ApiError("INVALID_REQUEST",400,false,"snapshotId does not match the canonical payload");
    const requestHash=hash(input),client=await this.pool.connect();
    try{
      await client.query("BEGIN");
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
        const result=await this.quiz.submit(userId,attempt);
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
    const current=await client.query<{content_version:number;checkpoint_ms:number;listened_ranges_ms:MillisecondRange[];source_updated_at:Date;revision:string;natural_end_observed:boolean;completed:boolean}>("SELECT content_version,checkpoint_ms,listened_ranges_ms,source_updated_at,revision::text,natural_end_observed,completed FROM user_learning_progress WHERE user_id=$1 AND piece_id=$2 FOR UPDATE",[userId,item.pieceId]);
    const incomingAt=new Date(item.updatedAt),previous=current.rows[0];
    if(previous&&previous.source_updated_at>incomingAt)return {pieceId:item.pieceId,status:"unchanged",reason:"server_has_newer_progress"};
    const sameVersion=previous?.content_version===item.contentVersion;
    const ranges=mergeRangesMs([...(sameVersion?previous.listened_ranges_ms:[]),...item.listenedRangesMs],serverDuration);
    const checkpoint=Math.min(serverDuration,Math.max(item.checkpointMs,previous?.content_version===item.contentVersion?previous.checkpoint_ms:0));
    // S-01 predates explicit natural-end evidence. Preserve its accepted-completion
    // behavior only when the imported ranges already satisfy coverage and tail gates.
    const legacyNaturalEnd=deriveProgressFacts(ranges,serverDuration,true).completed;
    const naturalEndObserved=Boolean((sameVersion&&previous.natural_end_observed)||legacyNaturalEnd);
    const facts=deriveProgressFacts(ranges,serverDuration,naturalEndObserved);
    const completed=Boolean((sameVersion&&previous.completed)||facts.completed);
    const material=!previous||!sameVersion||previous.checkpoint_ms!==checkpoint||previous.natural_end_observed!==naturalEndObserved||previous.completed!==completed||JSON.stringify(previous.listened_ranges_ms)!==JSON.stringify(ranges);
    if(!material)return {pieceId:item.pieceId,status:"unchanged",reason:"no_material_change",coverage:Number(facts.coverage.toFixed(6)),completed};
    if(previous){await client.query(`INSERT INTO user_learning_progress_history (user_id,piece_id,content_version,duration_ms,revision,checkpoint_ms,listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,server_updated_at,last_device_id,source_kind,source_reference) SELECT user_id,piece_id,content_version,duration_ms,revision,checkpoint_ms,listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,server_updated_at,last_device_id,source_kind,source_snapshot_id FROM user_learning_progress WHERE user_id=$1 AND piece_id=$2`,[userId,item.pieceId])}
    const revision=sameVersion?BigInt(previous.revision)+1n:1n;
    await client.query(`INSERT INTO user_learning_progress (user_id,piece_id,content_version,duration_ms,revision,checkpoint_ms,listened_ranges_ms,listened_ms,coverage,completed,natural_end_observed,source_updated_at,server_updated_at,source_kind,source_snapshot_id,change_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),'s01_local_import',$13,nextval('user_learning_progress_change_seq')) ON CONFLICT (user_id,piece_id) DO UPDATE SET content_version=EXCLUDED.content_version,duration_ms=EXCLUDED.duration_ms,revision=EXCLUDED.revision,checkpoint_ms=EXCLUDED.checkpoint_ms,listened_ranges_ms=EXCLUDED.listened_ranges_ms,listened_ms=EXCLUDED.listened_ms,coverage=EXCLUDED.coverage,completed=EXCLUDED.completed,natural_end_observed=EXCLUDED.natural_end_observed,source_updated_at=EXCLUDED.source_updated_at,server_updated_at=now(),imported_at=now(),source_kind=EXCLUDED.source_kind,source_snapshot_id=EXCLUDED.source_snapshot_id,change_seq=nextval('user_learning_progress_change_seq')`,[userId,item.pieceId,item.contentVersion,serverDuration,revision.toString(),checkpoint,JSON.stringify(ranges),facts.listenedMs,facts.coverage,completed,naturalEndObserved,incomingAt,snapshotId]);
    return {pieceId:item.pieceId,status:"accepted",coverage:Number(facts.coverage.toFixed(6)),completed,revision:revision.toString()};
  }
}

export const localImportCanonical={canonical,hash,snapshotFor};
