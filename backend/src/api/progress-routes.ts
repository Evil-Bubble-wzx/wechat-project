import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";
import type { AuditService } from "../observability/audit-service.ts";
import type { MetricsRegistry } from "../observability/metrics.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
import type { ProgressListResponse, ProgressMutationInput, ProgressMutationResponse, ProgressState } from "../sync/progress-sync-service.ts";

export type ProgressSyncServicePort={put(userId:string,pieceId:string,input:ProgressMutationInput):Promise<ProgressMutationResponse>;get(userId:string,pieceId:string):Promise<ProgressState>;list(userId:string,cursor:string|undefined,limit:number):Promise<ProgressListResponse>};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const text=(value:unknown,min:number,max:number,label:string)=>{if(typeof value!=="string"||value.length<min||value.length>max)throw new ApiError("INVALID_REQUEST",400,false,`${label} is invalid`);return value};
const integer=(value:unknown,min:number,max:number,label:string)=>{if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)throw new ApiError("INVALID_REQUEST",400,false,`${label} is invalid`);return Number(value)};
function authenticate(request:FastifyRequest,sessions:SessionServicePort){const authorization=request.headers.authorization;if(!authorization?.startsWith("Bearer "))throw new ApiError("UNAUTHENTICATED",401,false,"Bearer access token is required");return sessions.authenticateAccessToken(authorization.slice(7))}
function parseBody(value:unknown):ProgressMutationInput{
  if(!plain(value))throw new ApiError("INVALID_REQUEST",400,false,"JSON object body is required");
  const allowed=["schemaVersion","mutationId","baseRevision","contentVersion","checkpointMs","listenedRangesMs"];
  if(Object.keys(value).some(key=>!allowed.includes(key))||value.schemaVersion!==1)throw new ApiError("INVALID_REQUEST",400,false,"Progress mutation contains forbidden or unknown fields");
  const mutationId=text(value.mutationId,8,128,"mutationId"),baseRevision=text(value.baseRevision,1,20,"baseRevision");
  if(!/^\d+$/.test(baseRevision)||BigInt(baseRevision)>9_223_372_036_854_775_807n)throw new ApiError("INVALID_REQUEST",400,false,"baseRevision is invalid");
  const contentVersion=integer(value.contentVersion,1,1_000_000,"contentVersion"),checkpointMs=integer(value.checkpointMs,0,86_400_000,"checkpointMs");
  if(!Array.isArray(value.listenedRangesMs)||value.listenedRangesMs.length>500)throw new ApiError("INVALID_REQUEST",400,false,"listenedRangesMs is invalid");
  const ranges=value.listenedRangesMs.map((range,index)=>{if(!Array.isArray(range)||range.length!==2)return null;const start=range[0],end=range[1];if(!Number.isInteger(start)||!Number.isInteger(end)||Number(start)<0||Number(end)<=Number(start)||Number(end)>86_400_000)return null;if(index&&Number(start)<=Number((value.listenedRangesMs as unknown[][])[index-1]![1])+50)return null;return [Number(start),Number(end)] as [number,number]});
  if(ranges.some(range=>range===null))throw new ApiError("INVALID_REQUEST",400,false,"listenedRangesMs must be normalized, ordered and in bounds");
  if(Buffer.byteLength(JSON.stringify(value),"utf8")>65_536)throw new ApiError("INVALID_REQUEST",400,false,"Progress mutation exceeds 64 KiB");
  return {schemaVersion:1,mutationId,baseRevision,contentVersion,checkpointMs,listenedRangesMs:ranges as Array<[number,number]>};
}

export function registerProgressRoutes(app:FastifyInstance,service:ProgressSyncServicePort,sessions:SessionServicePort,audit?:AuditService,metrics?:MetricsRegistry,rateLimiter?:RateLimiterPort):void{
  app.put("/api/v1/me/progress/:pieceId",async request=>{
    const session=await authenticate(request,sessions),pieceId=text((request.params as {pieceId?:unknown}).pieceId,1,128,"pieceId"),input=parseBody(request.body);
    if(request.headers["idempotency-key"]!==input.mutationId)throw new ApiError("INVALID_REQUEST",400,false,"Idempotency-Key must equal mutationId");
    await rateLimiter?.consume("progress-sync",session.userId,30,60);
    const result=await service.put(session.userId,pieceId,input);
    metrics?.incrementDomain("tingyue_progress_sync_total",result.mergeStatus);
    await audit?.record({actorType:"user",actorId:session.userId,action:result.duplicate?"progress_sync_replayed":"progress_sync_merged",targetType:"learning_progress",targetId:pieceId,requestId:request.id,metadata:{mergeStatus:result.mergeStatus,revision:result.progress.revision,rangeCount:result.progress.listenedRangesMs.length,historicalVersion:result.historicalVersion}});
    return {requestId:request.id,...result};
  });
  app.get("/api/v1/me/progress/:pieceId",async request=>{const session=await authenticate(request,sessions),pieceId=text((request.params as {pieceId?:unknown}).pieceId,1,128,"pieceId");return {requestId:request.id,progress:await service.get(session.userId,pieceId)}});
  app.get("/api/v1/me/progress",async request=>{const session=await authenticate(request,sessions),query=request.query as {cursor?:unknown;limit?:unknown};const cursor=query.cursor===undefined?undefined:text(query.cursor,1,2048,"cursor"),limit=query.limit===undefined?50:integer(Number(query.limit),1,100,"limit");return {requestId:request.id,...await service.list(session.userId,cursor,limit)}});
}
