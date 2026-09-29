import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/api/app.ts";
import type { ProgressSyncServicePort } from "../src/api/progress-routes.ts";
import type { SessionServicePort } from "../src/api/session-routes.ts";
import type { AuthenticatedSession, CurrentUser, SessionTokenResponse } from "../src/auth/session-service.ts";
import type { ProgressMutationInput, ProgressMutationResponse, ProgressState } from "../src/sync/progress-sync-service.ts";

const userId="11111111-1111-4111-8111-111111111111";
class SyncSession implements SessionServicePort{
  async createWechatSession():Promise<SessionTokenResponse>{throw new Error("unused")}
  async refreshSession():Promise<SessionTokenResponse>{throw new Error("unused")}
  async authenticateAccessToken(token:string):Promise<AuthenticatedSession>{assert.equal(token,"sync-token");return {userId,sessionId:"22222222-2222-4222-8222-222222222222"}}
  async revokeSession():Promise<void>{throw new Error("unused")}
  async getCurrentUser():Promise<CurrentUser>{throw new Error("unused")}
}
const progress:ProgressState={pieceId:"peter-rabbit-01",contentVersion:1,revision:"4",checkpointMs:80000,listenedRangesMs:[[0,80000]],listenedMs:80000,coverage:0.25,completed:false,historicalVersion:false,serverUpdatedAt:"2026-09-29T08:00:00.000Z"};
class FakeProgress implements ProgressSyncServicePort{
  putCall:unknown=null;
  async put(receivedUserId:string,pieceId:string,input:ProgressMutationInput):Promise<ProgressMutationResponse>{this.putCall={userId:receivedUserId,pieceId,input};return {mutationId:input.mutationId,duplicate:false,mergeStatus:"applied",checkpointAccepted:true,historicalVersion:false,progress,acknowledgedAt:"2026-09-29T08:00:00.000Z"}}
  async get():Promise<ProgressState>{return progress}
  async list(_userId:string,_cursor:string|undefined,_limit:number){return {items:[progress],nextCursor:null}}
}
const input:ProgressMutationInput={schemaVersion:1,mutationId:"progress-mutation-1",baseRevision:"3",contentVersion:1,checkpointMs:80000,listenedRangesMs:[[0,80000]]};

test("progress routes authenticate before parsing",async()=>{
  const app=createApp({sessionService:new SyncSession(),progressSyncService:new FakeProgress()});
  const response=await app.inject({method:"PUT",url:"/api/v1/me/progress/peter-rabbit-01",payload:{}});
  assert.equal(response.statusCode,401);assert.equal(response.json().error.code,"UNAUTHENTICATED");await app.close();
});

test("progress PUT enforces mutation idempotency and rejects derived fields",async()=>{
  const service=new FakeProgress(),app=createApp({sessionService:new SyncSession(),progressSyncService:service}),authorization="Bearer sync-token";
  const mismatch=await app.inject({method:"PUT",url:"/api/v1/me/progress/peter-rabbit-01",headers:{authorization,"idempotency-key":"different"},payload:input});
  assert.equal(mismatch.statusCode,400);
  const forbidden=await app.inject({method:"PUT",url:"/api/v1/me/progress/peter-rabbit-01",headers:{authorization,"idempotency-key":input.mutationId},payload:{...input,completed:true}});
  assert.equal(forbidden.statusCode,400);
  const response=await app.inject({method:"PUT",url:"/api/v1/me/progress/peter-rabbit-01",headers:{authorization,"idempotency-key":input.mutationId},payload:input});
  assert.equal(response.statusCode,200);assert.equal(response.json().progress.revision,"4");assert.deepEqual(service.putCall,{userId,pieceId:"peter-rabbit-01",input});await app.close();
});

test("progress PUT rejects unnormalized ranges",async()=>{
  const app=createApp({sessionService:new SyncSession(),progressSyncService:new FakeProgress()}),headers={authorization:"Bearer sync-token","idempotency-key":input.mutationId};
  const response=await app.inject({method:"PUT",url:"/api/v1/me/progress/peter-rabbit-01",headers,payload:{...input,listenedRangesMs:[[100,200],[150,300]]}});
  assert.equal(response.statusCode,400);await app.close();
});

test("progress GET endpoints return one state and a page",async()=>{
  const app=createApp({sessionService:new SyncSession(),progressSyncService:new FakeProgress()}),headers={authorization:"Bearer sync-token"};
  const one=await app.inject({method:"GET",url:"/api/v1/me/progress/peter-rabbit-01",headers});
  const page=await app.inject({method:"GET",url:"/api/v1/me/progress?limit=50",headers});
  assert.equal(one.statusCode,200);assert.equal(one.json().progress.pieceId,"peter-rabbit-01");assert.equal(page.statusCode,200);assert.equal(page.json().items.length,1);await app.close();
});
