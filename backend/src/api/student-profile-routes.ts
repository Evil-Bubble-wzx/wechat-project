import type {FastifyInstance,FastifyRequest} from "fastify";
import type {SessionServicePort} from "./session-routes.ts";
import type {StudentProfileService,ProfileMutation} from "../profile/student-profile-service.ts";
import type {RateLimiterPort} from "../security/rate-limiter.ts";
import {ApiError} from "./errors.ts";
export type StudentProfileServicePort=Pick<StudentProfileService,"assertManager"|"me"|"options"|"get"|"update">;
function invalid():never{throw new ApiError("INVALID_REQUEST",400,false,"Student profile request is invalid")}
function code(value:unknown):string{if(typeof value!=="string"||!/^student_[a-f0-9]{32}$/.test(value))invalid();return value}
export function parseProfileMutation(value:unknown):ProfileMutation{
  if(!value||typeof value!=="object"||Array.isArray(value))invalid();
  const body=value as Record<string,unknown>;
  const keys=["mutationId","baseRevision","campusId","grade","readingLevel","reason"];
  if(Object.keys(body).length!==keys.length||Object.keys(body).some(k=>!keys.includes(k)))invalid();
  if(typeof body.mutationId!=="string"||!/^[a-zA-Z0-9:_-]{8,128}$/.test(body.mutationId)||typeof body.baseRevision!=="string"||!/^(0|[1-9][0-9]{0,18})$/.test(body.baseRevision))invalid();
  if(body.campusId!==null&&(typeof body.campusId!=="string"||!/^[a-z][a-z0-9-]{0,31}$/.test(body.campusId)))invalid();
  if(body.grade!==null&&(typeof body.grade!=="string"||!/^(k|[1-9])$/.test(body.grade)))invalid();
  if(body.readingLevel!==null&&(typeof body.readingLevel!=="string"||!/^[1-5]$/.test(body.readingLevel)))invalid();
  if(body.campusId===null&&(body.grade!==null||body.readingLevel!==null))invalid();
  if(typeof body.reason!=="string"||body.reason.trim()!==body.reason||body.reason.length<1||body.reason.length>256||/[\u0000-\u001f\u007f]/.test(body.reason))invalid();
  return{mutationId:body.mutationId,baseRevision:body.baseRevision,campusId:body.campusId as string|null,grade:body.grade as string|null,readingLevel:body.readingLevel as string|null,reason:body.reason};
}
export function registerStudentProfileRoutes(app:FastifyInstance,service:StudentProfileServicePort,sessions:SessionServicePort,limiter?:RateLimiterPort){
  async function auth(request:FastifyRequest,manage=false){
    const header=request.headers.authorization;
    if(!header?.startsWith("Bearer ")||header.length<=7)throw new ApiError("UNAUTHENTICATED",401,false,"Bearer access token is required");
    const session=await sessions.authenticateAccessToken(header.slice(7));
    if(manage)await service.assertManager(session.userId);
    await limiter?.consume(manage?"student-profile-manage":"student-profile-read",session.userId,manage?30:120,60);
    return session.userId;
  }
  function noQuery(request:FastifyRequest){if(Object.keys(request.query as Record<string,unknown>).length)invalid()}
  app.get("/api/v1/me/student-profile",async request=>{const id=await auth(request);noQuery(request);return{requestId:request.id,...await service.me(id)}});
  app.get("/api/v1/admin/student-profile-options",async request=>{const id=await auth(request,true);noQuery(request);return{requestId:request.id,...await service.options(id)}});
  app.get("/api/v1/admin/student-profiles/:studentCode",async request=>{const id=await auth(request,true);noQuery(request);return{requestId:request.id,...await service.get(id,code((request.params as any).studentCode))}});
  app.put("/api/v1/admin/student-profiles/:studentCode",async request=>{
    const id=await auth(request,true);noQuery(request);
    const target=code((request.params as any).studentCode),input=parseProfileMutation(request.body);
    if(request.headers["idempotency-key"]!==input.mutationId)invalid();
    return{requestId:request.id,...await service.update(id,target,input,request.id)};
  });
}
