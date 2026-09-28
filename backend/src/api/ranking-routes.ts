import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RankingPeriodType } from "../ranking/aggregation-service.ts";
import type { RankingQueryService } from "../ranking/query-service.ts";
import type { AuditService } from "../observability/audit-service.ts";
import type { MetricsRegistry } from "../observability/metrics.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";

export type RankingServicePort = Pick<RankingQueryService,"options"|"rankings"|"detail">;

function bearer(request:FastifyRequest):string{
  const value=request.headers.authorization;
  if(!value?.startsWith("Bearer ")||value.length<=7)throw new ApiError("UNAUTHENTICATED",401,false,"Bearer access token is required");
  return value.slice(7);
}

function page(query:Record<string,unknown>):{cursor:string|undefined;limit:number}{
  const cursor=query.cursor;
  const limit=query.limit===undefined?20:Number(query.limit);
  if((cursor!==undefined&&typeof cursor!=="string")||!Number.isInteger(limit)||limit<1||limit>100){
    throw new ApiError("INVALID_REQUEST",400,false,"Cursor or limit is invalid");
  }
  return {cursor:cursor as string|undefined,limit};
}

function filters(query:Record<string,unknown>){
  for(const key of ["campusId","periodType","periodKey","grade","level"]){
    if(query[key]!==undefined&&typeof query[key]!=="string")throw new ApiError("INVALID_REQUEST",400,false,`${key} is invalid`);
  }
  if(typeof query.campusId!=="string"||typeof query.periodType!=="string")throw new ApiError("INVALID_REQUEST",400,false,"campusId and periodType are required");
  return {campusId:query.campusId,periodType:query.periodType as RankingPeriodType,periodKey:query.periodKey as string|undefined,grade:query.grade as string|undefined,level:query.level as string|undefined};
}

export function registerRankingRoutes(app:FastifyInstance,ranking:RankingServicePort,sessions:SessionServicePort,audit?:AuditService,metrics?:MetricsRegistry,rateLimiter?:RateLimiterPort):void{
  app.get("/api/v1/ranking-options",async(request)=>{
    const session=await sessions.authenticateAccessToken(bearer(request));
    await rateLimiter?.consume("ranking-read",session.userId,120,60);
    return {requestId:request.id,...await ranking.options()};
  });

  app.get("/api/v1/rankings",async(request)=>{
    const session=await sessions.authenticateAccessToken(bearer(request));
    await rateLimiter?.consume("ranking-read",session.userId,120,60);
    const query=request.query as Record<string,unknown>;
    const pagination=page(query);
    const normalized=filters(query);
    const response=await ranking.rankings(session.userId,normalized,pagination.cursor,pagination.limit);
    metrics?.incrementDomain("tingyue_ranking_queries_total",response.status);
    await audit?.record({
      actorType:"user",actorId:session.userId,action:"ranking_list_read",
      targetType:"ranking_snapshot",targetId:`${normalized.campusId}:${normalized.periodType}:${normalized.periodKey??"latest"}`,
      requestId:request.id,
      metadata:{campusId:normalized.campusId,periodType:normalized.periodType,periodKey:normalized.periodKey??null,grade:normalized.grade??null,level:normalized.level??null,status:response.status,resultCount:response.items.length},
    });
    return {requestId:request.id,...response};
  });

  app.get("/api/v1/rankings/:participantId/quizzes",async(request)=>{
    const session=await sessions.authenticateAccessToken(bearer(request));
    await rateLimiter?.consume("ranking-read",session.userId,120,60);
    const {participantId}=request.params as {participantId:string};
    if(participantId.length<8||participantId.length>128)throw new ApiError("INVALID_REQUEST",400,false,"participantId is invalid");
    const query=request.query as Record<string,unknown>;
    const pagination=page(query);
    const normalized=filters(query);
    const response=await ranking.detail(normalized,participantId,pagination.cursor,pagination.limit);
    metrics?.incrementDomain("tingyue_ranking_queries_total","detail_ready");
    await audit?.record({
      actorType:"user",actorId:session.userId,action:"ranking_detail_read",
      targetType:"ranking_participant",targetId:participantId,requestId:request.id,
      metadata:{campusId:normalized.campusId,periodType:normalized.periodType,periodKey:normalized.periodKey??null,grade:normalized.grade??null,level:normalized.level??null,resultCount:response.quizzes.length},
    });
    return {requestId:request.id,...response};
  });
}
