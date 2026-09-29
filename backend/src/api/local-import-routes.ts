import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";
import type { AuditService } from "../observability/audit-service.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
import type { LocalImportInput, LocalImportResponse, LocalProgressInput } from "../sync/local-import-service.ts";

export type LocalImportServicePort={import(userId:string,input:LocalImportInput):Promise<LocalImportResponse>};

const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function exact(value:Record<string,unknown>,allowed:string[],label:string){if(Object.keys(value).some(key=>!allowed.includes(key)))throw new ApiError("INVALID_REQUEST",400,false,`${label} contains forbidden or unknown fields`)}
function text(value:unknown,min:number,max:number,label:string):string{if(typeof value!=="string"||value.length<min||value.length>max)throw new ApiError("INVALID_REQUEST",400,false,`${label} is invalid`);return value}
function integer(value:unknown,min:number,max:number,label:string):number{if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)throw new ApiError("INVALID_REQUEST",400,false,`${label} is invalid`);return Number(value)}

function parseProgress(value:unknown):LocalProgressInput{
  if(!plain(value))throw new ApiError("INVALID_REQUEST",400,false,"Progress item must be an object");
  exact(value,["pieceId","contentVersion","durationMs","checkpointMs","listenedRangesMs","updatedAt"],"Progress item");
  const durationMs=integer(value.durationMs,1,86_400_000,"durationMs"),checkpointMs=integer(value.checkpointMs,0,durationMs,"checkpointMs");
  if(!Array.isArray(value.listenedRangesMs)||value.listenedRangesMs.length>500)throw new ApiError("INVALID_REQUEST",400,false,"listenedRangesMs is invalid");
  const ranges=value.listenedRangesMs.map((range,index)=>{
    if(!Array.isArray(range)||range.length!==2)return null;
    const start=range[0],end=range[1];
    if(!Number.isInteger(start)||!Number.isInteger(end)||Number(start)<0||Number(end)<=Number(start)||Number(end)>durationMs)return null;
    if(index&&Number(start)<=Number((value.listenedRangesMs as unknown[][])[index-1]![1])+50)return null;
    return [Number(start),Number(end)] as [number,number];
  });
  if(ranges.some(range=>range===null))throw new ApiError("INVALID_REQUEST",400,false,"listenedRangesMs must be normalized, ordered and in bounds");
  const updatedAt=new Date(text(value.updatedAt,20,40,"updatedAt"));
  if(Number.isNaN(updatedAt.getTime()))throw new ApiError("INVALID_REQUEST",400,false,"updatedAt is invalid");
  return {pieceId:text(value.pieceId,1,128,"pieceId"),contentVersion:integer(value.contentVersion,1,1_000_000,"contentVersion"),durationMs,checkpointMs,listenedRangesMs:ranges as Array<[number,number]>,updatedAt:updatedAt.toISOString()};
}
function parseQuiz(value:unknown):LocalImportInput["payload"]["quizAttempts"][number]{
  if(!plain(value))throw new ApiError("INVALID_REQUEST",400,false,"Quiz attempt must be an object");
  const fields=["schemaVersion","attemptId","workId","pieceId","contentVersion","quizVersion","questionIds","selectedOptions","startedAt","submittedAt"];
  exact(value,fields,"Quiz attempt");
  if(value.schemaVersion!==1||!Array.isArray(value.questionIds)||!Array.isArray(value.selectedOptions)||value.questionIds.length<1||value.questionIds.length>100||value.questionIds.length!==value.selectedOptions.length||!value.questionIds.every(item=>typeof item==="string"&&item.length>0&&item.length<=128)||new Set(value.questionIds).size!==value.questionIds.length||!value.selectedOptions.every(item=>Number.isInteger(item)&&Number(item)>=0))throw new ApiError("INVALID_REQUEST",400,false,"Quiz attempt fields are invalid");
  const started=new Date(text(value.startedAt,20,40,"startedAt")),submitted=new Date(text(value.submittedAt,20,40,"submittedAt"));
  if(Number.isNaN(started.getTime())||Number.isNaN(submitted.getTime())||submitted<started)throw new ApiError("INVALID_REQUEST",400,false,"Quiz timestamps are invalid");
  return {schemaVersion:1,attemptId:text(value.attemptId,8,128,"attemptId"),workId:text(value.workId,1,128,"workId"),pieceId:text(value.pieceId,1,128,"pieceId"),contentVersion:integer(value.contentVersion,1,1_000_000,"contentVersion"),quizVersion:integer(value.quizVersion,1,1_000_000,"quizVersion"),questionIds:value.questionIds as string[],selectedOptions:value.selectedOptions as number[],startedAt:started.toISOString(),submittedAt:submitted.toISOString()};
}
function parseInput(request:FastifyRequest):LocalImportInput{
  if(!plain(request.body))throw new ApiError("INVALID_REQUEST",400,false,"JSON object body is required");
  exact(request.body,["snapshotId","payload","limitations"],"Local import request");
  const snapshotId=text(request.body.snapshotId,71,71,"snapshotId");
  if(!/^s01-v1:[a-f0-9]{64}$/.test(snapshotId))throw new ApiError("INVALID_REQUEST",400,false,"snapshotId is invalid");
  if(!plain(request.body.payload)){throw new ApiError("INVALID_REQUEST",400,false,"payload is invalid")}
  exact(request.body.payload,["schemaVersion","progress","words","quizAttempts"],"Local import payload");
  const payload=request.body.payload;
  if(payload.schemaVersion!==1||!Array.isArray(payload.progress)||!Array.isArray(payload.words)||!Array.isArray(payload.quizAttempts)||payload.progress.length>100||payload.words.length>1000||payload.quizAttempts.length>100)throw new ApiError("INVALID_REQUEST",400,false,"Local import collections are invalid");
  if(!payload.progress.length&&!payload.words.length&&!payload.quizAttempts.length)throw new ApiError("INVALID_REQUEST",400,false,"Local import is empty");
  const progress=payload.progress.map(parseProgress),pieceIds=progress.map(item=>item.pieceId);
  if(new Set(pieceIds).size!==pieceIds.length)throw new ApiError("INVALID_REQUEST",400,false,"Progress pieceId values must be unique");
  const words=payload.words.map(value=>{if(!plain(value)){throw new ApiError("INVALID_REQUEST",400,false,"Word item must be an object")}exact(value,["surface"],"Word item");const surface=text(value.surface,1,80,"surface");if(surface.trim()!==surface)throw new ApiError("INVALID_REQUEST",400,false,"Word surface must be trimmed");return {surface}});
  if(new Set(words.map(item=>item.surface)).size!==words.length)throw new ApiError("INVALID_REQUEST",400,false,"Word surfaces must be unique");
  const quizAttempts=payload.quizAttempts.map(parseQuiz),attemptIds=quizAttempts.map(item=>item.attemptId);
  if(new Set(attemptIds).size!==attemptIds.length)throw new ApiError("INVALID_REQUEST",400,false,"Quiz attemptId values must be unique");
  if(!plain(request.body.limitations)||request.body.limitations.words!=="surface_only"||Object.keys(request.body.limitations).length!==1)throw new ApiError("INVALID_REQUEST",400,false,"limitations.words must be surface_only");
  return {snapshotId,payload:{schemaVersion:1,progress,words,quizAttempts},limitations:{words:"surface_only"}};
}

export function registerLocalImportRoutes(app:FastifyInstance,service:LocalImportServicePort,sessions:SessionServicePort,audit?:AuditService,rateLimiter?:RateLimiterPort):void{
  app.post("/api/v1/me/local-import",async request=>{
    const authorization=request.headers.authorization;
    if(!authorization?.startsWith("Bearer "))throw new ApiError("UNAUTHENTICATED",401,false,"Bearer access token is required");
    const session=await sessions.authenticateAccessToken(authorization.slice(7));
    const input=parseInput(request),idempotency=request.headers["idempotency-key"];
    if(idempotency!==input.snapshotId)throw new ApiError("INVALID_REQUEST",400,false,"Idempotency-Key must equal snapshotId");
    await rateLimiter?.consume("local-import",session.userId,5,60);
    const result=await service.import(session.userId,input);
    await audit?.record({actorType:"user",actorId:session.userId,action:result.duplicate?"local_import_replayed":"local_import_completed",targetType:"local_import_snapshot",targetId:input.snapshotId,requestId:request.id,metadata:{duplicate:result.duplicate,summary:result.summary}});
    return {requestId:request.id,...result};
  });
}
