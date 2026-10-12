import type { FastifyInstance } from "fastify";
import { ApiError } from "./errors.ts";
import type { SessionServicePort } from "./session-routes.ts";
import type { LearningHistoryService } from "../quiz/history-service.ts";
import type { RateLimiterPort } from "../security/rate-limiter.ts";
export type LearningHistoryServicePort=Pick<LearningHistoryService,"history"|"summary">;
export function registerLearningHistoryRoutes(app:FastifyInstance,service:LearningHistoryServicePort,sessions:SessionServicePort,rateLimiter?:RateLimiterPort){
  async function account(authorization:string|undefined){
    if(!authorization?.startsWith("Bearer "))throw new ApiError("UNAUTHENTICATED",401,false,"Bearer access token required");
    return (await sessions.authenticateAccessToken(authorization.slice(7))).userId;
  }
  app.get("/api/v1/me/quiz-history",async request=>{
    const userId=await account(request.headers.authorization),query=request.query as Record<string,unknown>;
    const limit=query.limit===undefined?100:Number(query.limit);
    if(Object.keys(query).some(key=>!["cursor","limit"].includes(key))||
      (query.limit!==undefined&&(typeof query.limit!=="string"||!/^[1-9][0-9]*$/.test(query.limit)))||
      !Number.isInteger(limit)||limit<1||limit>100||
      (query.cursor!==undefined&&(typeof query.cursor!=="string"||!query.cursor||query.cursor.length>512))){
      throw new ApiError("INVALID_REQUEST",400,false,"Quiz history query is invalid");
    }
    await rateLimiter?.consume("quiz-history",userId,120,60);
    return {requestId:request.id,...await service.history(userId,query.cursor as string??null,limit)};
  });
  app.get("/api/v1/me/learning-summary",async request=>{
    const userId=await account(request.headers.authorization);
    if(Object.keys(request.query as Record<string,unknown>).length)throw new ApiError("INVALID_REQUEST",400,false,"Learning summary has no query parameters");
    await rateLimiter?.consume("learning-summary",userId,60,60);
    return {requestId:request.id,...await service.summary(userId)};
  });
}
