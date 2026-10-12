import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";
import type { ReaderLibraryService, LibrarySyncInput, LibraryOperation } from "../sync/reader-library-service.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
import type { AuditService } from "../observability/audit-service.ts";
export type ReaderLibraryServicePort=Pick<ReaderLibraryService,"sync">;
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function fail():never{throw new ApiError("INVALID_REQUEST",400,false,"Library sync request is invalid")}
function exact(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).some(key=>!keys.includes(key)))fail()}
function text(value:unknown,min:number,max:number):string{if(typeof value!=="string"||value.length<min||value.length>max||value.trim()!==value)fail();return value}
function parse(value:unknown):LibrarySyncInput{
  if(!plain(value))fail();exact(value,["schemaVersion","batchId","cursor","operations","limit"]);
  if(value.schemaVersion!==1||!Number.isInteger(value.limit)||Number(value.limit)<1||Number(value.limit)>100||!Array.isArray(value.operations)||value.operations.length>50)fail();
  if(value.cursor!==null&&(typeof value.cursor!=="string"||value.cursor.length>512))fail();
  const operations=value.operations.map((item):LibraryOperation=>{
    if(!plain(item))fail();exact(item,["operationId","workId","action","baseRevision","occurredAt"]);
    const operationId=text(item.operationId,78,78),baseRevision=text(item.baseRevision,1,20),occurredAt=text(item.occurredAt,24,24);
    if(!/^library-op-v1:[a-f0-9]{64}$/.test(operationId)||!/^(0|[1-9][0-9]*)$/.test(baseRevision)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(occurredAt)||!Number.isFinite(Date.parse(occurredAt)))fail();
    if(item.action!=="favorite"&&item.action!=="unfavorite"&&item.action!=="open")fail();
    return {operationId,workId:text(item.workId,1,128),action:item.action,baseRevision,occurredAt};
  });
  if(new Set(operations.map(item=>item.operationId)).size!==operations.length)fail();
  return {schemaVersion:1,batchId:text(value.batchId,8,128),cursor:value.cursor as string|null,operations,limit:Number(value.limit)};
}
export function registerReaderLibraryRoutes(app:FastifyInstance,library:ReaderLibraryServicePort,sessions:SessionServicePort,audit?:AuditService,rateLimiter?:RateLimiterPort){
  app.post("/api/v1/me/library/sync",async request=>{
    const auth=request.headers.authorization;
    if(!auth?.startsWith("Bearer "))throw new ApiError("UNAUTHENTICATED",401,false,"Bearer access token required");
    const session=await sessions.authenticateAccessToken(auth.slice(7));
    const input=parse(request.body);
    if(request.headers["idempotency-key"]!==input.batchId)fail();
    await rateLimiter?.consume("library-sync",session.userId,60,60);
    const result=await library.sync(session.userId,input);
    await audit?.record({actorType:"user",actorId:session.userId,action:"reader_library_synced",targetType:"library_batch",targetId:input.batchId,requestId:request.id,metadata:{operationCount:input.operations.length,changeCount:result.changes.length}});
    return {requestId:request.id,...result};
  });
}
