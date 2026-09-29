import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { ApiError } from "../api/errors.ts";

export type ProgressMutationInput={schemaVersion:1;mutationId:string;baseRevision:string;contentVersion:number;checkpointMs:number;listenedRangesMs:Array<[number,number]>};
export type ProgressState={pieceId:string;contentVersion:number;revision:string;checkpointMs:number;listenedRangesMs:Array<[number,number]>;listenedMs:number;coverage:number;completed:boolean;historicalVersion:boolean;serverUpdatedAt:string};
export type ProgressMutationResponse={mutationId:string;duplicate:boolean;mergeStatus:"applied"|"merged_stale_base";checkpointAccepted:boolean;historicalVersion:boolean;progress:ProgressState;acknowledgedAt:string};
export type ProgressListResponse={items:ProgressState[];nextCursor:string|null};

function canonical(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.keys(value as Record<string,unknown>).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");

function mergeRanges(input:Array<[number,number]>,duration:number):Array<[number,number]>{
  const sorted=input.map(range=>[Math.max(0,range[0]),Math.min(duration,range[1])] as [number,number]).filter(range=>range[1]>range[0]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const output:Array<[number,number]>=[];
  for(const range of sorted){const previous=output.at(-1);if(previous&&range[0]<=previous[1]+50)previous[1]=Math.max(previous[1],range[1]);else output.push(range)}
  return output;
}
function derived(ranges:Array<[number,number]>,duration:number,alreadyCompleted=false){
  const listenedMs=Math.min(duration,ranges.reduce((total,[start,end])=>total+end-start,0));
  const coverage=duration?listenedMs/duration:0,tailStart=Math.max(0,duration-3000);
  const tailCovered=ranges.some(([start,end])=>start<=tailStart+50&&end>=duration-250);
  return {listenedMs,coverage,completed:alreadyCompleted||(coverage>=0.9&&tailCovered)};
}
const encodeCursor=(pieceId:string)=>Buffer.from(JSON.stringify({pieceId}),"utf8").toString("base64url");
function decodeCursor(cursor:string|undefined):string|null{
  if(!cursor)return null;
  try{const value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));if(value&&typeof value.pieceId==="string"&&value.pieceId)return value.pieceId}catch{}
  throw new ApiError("INVALID_REQUEST",400,false,"Progress cursor is invalid");
}

type ProgressRow={piece_id:string;content_version:number;revision:string;duration_ms:number;checkpoint_ms:number;listened_ranges_ms:Array<[number,number]>;listened_ms:number;coverage:string;completed:boolean;historical:boolean;server_updated_at:Date};
function state(row:ProgressRow):ProgressState{return {pieceId:row.piece_id,contentVersion:row.content_version,revision:String(row.revision),checkpointMs:row.checkpoint_ms,listenedRangesMs:row.listened_ranges_ms,listenedMs:row.listened_ms,coverage:Number(Number(row.coverage).toFixed(6)),completed:row.completed,historicalVersion:row.historical,serverUpdatedAt:row.server_updated_at.toISOString()}}

export class ProgressSyncService{
  private readonly pool:Pool;
  constructor(pool:Pool){this.pool=pool}

  async put(userId:string,pieceId:string,input:ProgressMutationInput):Promise<ProgressMutationResponse>{
    const requestHash=hash({pieceId,input}),client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`progress-sync:${userId}:${pieceId}:${input.contentVersion}`]);
      await client.query("DELETE FROM progress_sync_mutations WHERE user_id=$1 AND mutation_id=$2 AND expires_at<=now()",[userId,input.mutationId]);
      const replay=await client.query<{request_hash:string;response:ProgressMutationResponse}>("SELECT request_hash,response FROM progress_sync_mutations WHERE user_id=$1 AND mutation_id=$2 AND expires_at>now()",[userId,input.mutationId]);
      if(replay.rows[0]){
        if(replay.rows[0].request_hash.trim()!==requestHash)throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"mutationId was already used with a different request");
        await client.query("COMMIT");return {...replay.rows[0].response,duplicate:true};
      }
      const resource=await this.resource(client,pieceId,input.contentVersion);
      if(input.checkpointMs>resource.durationMs||input.listenedRangesMs.some(([,end])=>end>resource.durationMs))throw new ApiError("INVALID_REQUEST",400,false,"Progress evidence exceeds the authoritative audio duration");
      const previousResult=await client.query<ProgressRow>("SELECT * FROM user_learning_progress WHERE user_id=$1 AND piece_id=$2 AND content_version=$3 FOR UPDATE",[userId,pieceId,input.contentVersion]);
      const previous=previousResult.rows[0],currentRevision=previous?BigInt(previous.revision):0n,baseRevision=BigInt(input.baseRevision);
      const checkpointAccepted=baseRevision===currentRevision;
      const ranges=mergeRanges([...(previous?.listened_ranges_ms??[]),...input.listenedRangesMs],resource.durationMs);
      const checkpoint=checkpointAccepted?Math.min(resource.durationMs,input.checkpointMs):(previous?.checkpoint_ms??0);
      const facts=derived(ranges,resource.durationMs,previous?.completed??false),revision=currentRevision+1n,acknowledgedAt=new Date().toISOString();
      const saved=await client.query<ProgressRow>(`INSERT INTO user_learning_progress (user_id,piece_id,content_version,duration_ms,checkpoint_ms,listened_ranges_ms,listened_ms,coverage,completed,source_updated_at,source_snapshot_id,revision,server_updated_at,last_mutation_id,historical)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,$10,$13)
        ON CONFLICT (user_id,piece_id,content_version) DO UPDATE SET duration_ms=EXCLUDED.duration_ms,checkpoint_ms=EXCLUDED.checkpoint_ms,listened_ranges_ms=EXCLUDED.listened_ranges_ms,listened_ms=EXCLUDED.listened_ms,coverage=EXCLUDED.coverage,completed=user_learning_progress.completed OR EXCLUDED.completed,revision=EXCLUDED.revision,server_updated_at=EXCLUDED.server_updated_at,last_mutation_id=EXCLUDED.last_mutation_id,historical=EXCLUDED.historical
        RETURNING *`,[userId,pieceId,input.contentVersion,resource.durationMs,checkpoint,JSON.stringify(ranges),facts.listenedMs,facts.coverage,facts.completed,input.mutationId,revision.toString(),acknowledgedAt,resource.historical]);
      const response:ProgressMutationResponse={mutationId:input.mutationId,duplicate:false,mergeStatus:checkpointAccepted?"applied":"merged_stale_base",checkpointAccepted,historicalVersion:resource.historical,progress:state(saved.rows[0]!),acknowledgedAt};
      await client.query("INSERT INTO progress_sync_mutations (user_id,mutation_id,request_hash,response) VALUES ($1,$2,$3,$4)",[userId,input.mutationId,requestHash,JSON.stringify(response)]);
      await client.query("COMMIT");return response;
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  }

  async get(userId:string,pieceId:string):Promise<ProgressState>{
    const resource=await this.currentResource(this.pool,pieceId);
    const result=await this.pool.query<ProgressRow>("SELECT * FROM user_learning_progress WHERE user_id=$1 AND piece_id=$2 AND content_version=$3",[userId,pieceId,resource.contentVersion]);
    if(result.rows[0])return state(result.rows[0]);
    return {pieceId,contentVersion:resource.contentVersion,revision:"0",checkpointMs:0,listenedRangesMs:[],listenedMs:0,coverage:0,completed:false,historicalVersion:false,serverUpdatedAt:new Date(0).toISOString()};
  }

  async list(userId:string,cursor:string|undefined,limit:number):Promise<ProgressListResponse>{
    const after=decodeCursor(cursor),result=await this.pool.query<ProgressRow>(`SELECT ulp.* FROM user_learning_progress ulp JOIN pieces p ON p.id=ulp.piece_id JOIN content_versions cv ON cv.id=p.current_content_version_id AND cv.content_version=ulp.content_version WHERE ulp.user_id=$1 AND ($2::text IS NULL OR ulp.piece_id>$2) ORDER BY ulp.piece_id LIMIT $3`,[userId,after,limit+1]);
    const hasMore=result.rows.length>limit,rows=hasMore?result.rows.slice(0,limit):result.rows;
    return {items:rows.map(state),nextCursor:hasMore?encodeCursor(rows.at(-1)!.piece_id):null};
  }

  private async currentResource(query:Pick<Pool,"query">,pieceId:string):Promise<{contentVersion:number;durationMs:number}>{
    const result=await query.query<{content_version:number;duration_ms:string|null}>(`SELECT cv.content_version,asset.duration_ms::text FROM pieces p JOIN works w ON w.id=p.work_id JOIN content_versions cv ON cv.id=p.current_content_version_id LEFT JOIN content_assets asset ON asset.piece_id=p.id AND asset.content_version=cv.content_version AND asset.asset_type='audio' AND asset.status IN ('ready','published') WHERE p.id=$1 AND p.status='published' AND w.status='published' AND p.access_type='free' AND w.access_type='free'`,[pieceId]);
    const row=result.rows[0],durationMs=row?.duration_ms===null?null:Number(row?.duration_ms);
    if(!row||!durationMs)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Published progress resource was not found");
    return {contentVersion:row.content_version,durationMs};
  }

  private async resource(client:PoolClient,pieceId:string,contentVersion:number):Promise<{durationMs:number;historical:boolean}>{
    const result=await client.query<{status:string;current_version:number;duration_ms:string|null}>(`SELECT cv.status,current.content_version AS current_version,asset.duration_ms::text FROM pieces p JOIN works w ON w.id=p.work_id JOIN content_versions cv ON cv.piece_id=p.id AND cv.content_version=$2 JOIN content_versions current ON current.id=p.current_content_version_id LEFT JOIN content_assets asset ON asset.piece_id=p.id AND asset.content_version=cv.content_version AND asset.asset_type='audio' AND asset.status IN ('ready','published') WHERE p.id=$1 AND p.status='published' AND w.status='published' AND p.access_type='free' AND w.access_type='free'`,[pieceId,contentVersion]);
    const row=result.rows[0],durationMs=row?.duration_ms===null?null:Number(row?.duration_ms);
    if(!row||!durationMs||!["published","superseded"].includes(row.status))throw new ApiError("CONTENT_VERSION_UNAVAILABLE",409,false,"Progress content version is unavailable");
    return {durationMs,historical:row.current_version!==contentVersion};
  }
}

export const progressSyncInternals={mergeRanges,derived,canonical,hash,encodeCursor,decodeCursor};
