import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createApp } from "../src/api/app.ts";
import type { LocalImportServicePort } from "../src/api/local-import-routes.ts";
import type { AuthenticatedSession, CurrentUser, SessionTokenResponse } from "../src/auth/session-service.ts";
import type { SessionServicePort } from "../src/api/session-routes.ts";
import type { LocalImportInput, LocalImportResponse } from "../src/sync/local-import-service.ts";

class ImportSession implements SessionServicePort{
  async createWechatSession():Promise<SessionTokenResponse>{throw new Error("unused")}
  async refreshSession():Promise<SessionTokenResponse>{throw new Error("unused")}
  async authenticateAccessToken(token:string):Promise<AuthenticatedSession>{assert.equal(token,"import-token");return {userId:"11111111-1111-4111-8111-111111111111",sessionId:"22222222-2222-4222-8222-222222222222"}}
  async revokeSession():Promise<void>{throw new Error("unused")}
  async getCurrentUser():Promise<CurrentUser>{throw new Error("unused")}
}
class FakeImport implements LocalImportServicePort{
  last:unknown=null;
  async import(userId:string,input:LocalImportInput):Promise<LocalImportResponse>{this.last={userId,input};return {snapshotId:input.snapshotId,status:"completed",duplicate:false,summary:{progress:{accepted:0,unchanged:0,rejected:0},words:{pending:1,reused:0,rejected:0},quizAttempts:{verified:0,rejected:0}},items:{progress:[],words:[{surface:"Once",status:"pending_resolution"}],quizAttempts:[]},acknowledgedAt:"2026-09-28T08:00:00.000Z"}}
}
const payload={schemaVersion:1 as const,progress:[],words:[{surface:"Once"}],quizAttempts:[]};
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value as Record<string,unknown>).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(",")}}`:JSON.stringify(value);
const snapshotId=`s01-v1:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
const request:LocalImportInput={snapshotId,payload,limitations:{words:"surface_only"}};

test("local import requires authentication before parsing learning data",async()=>{
  const app=createApp({sessionService:new ImportSession(),localImportService:new FakeImport()});
  const response=await app.inject({method:"POST",url:"/api/v1/me/local-import",payload:{}});
  assert.equal(response.statusCode,401);assert.equal(response.json().error.code,"UNAUTHENTICATED");await app.close();
});

test("local import requires snapshot idempotency and forwards only allowlisted data",async()=>{
  const service=new FakeImport(),app=createApp({sessionService:new ImportSession(),localImportService:service}),authorization="Bearer import-token";
  const mismatch=await app.inject({method:"POST",url:"/api/v1/me/local-import",headers:{authorization,"idempotency-key":"wrong-key"},payload:request});
  assert.equal(mismatch.statusCode,400);
  const response=await app.inject({method:"POST",url:"/api/v1/me/local-import",headers:{authorization,"idempotency-key":snapshotId},payload:request});
  assert.equal(response.statusCode,200);assert.equal(response.json().summary.words.pending,1);assert.deepEqual(service.last,{userId:"11111111-1111-4111-8111-111111111111",input:request});await app.close();
});

test("local import rejects client-derived fields and unnormalized ranges",async()=>{
  const app=createApp({sessionService:new ImportSession(),localImportService:new FakeImport()}),headers={authorization:"Bearer import-token","idempotency-key":snapshotId};
  const forbidden=await app.inject({method:"POST",url:"/api/v1/me/local-import",headers,payload:{...request,payload:{...payload,score:100}}});
  assert.equal(forbidden.statusCode,400);
  const ranges=await app.inject({method:"POST",url:"/api/v1/me/local-import",headers,payload:{...request,payload:{...payload,progress:[{pieceId:"peter-rabbit-01",contentVersion:1,durationMs:1000,checkpointMs:0,listenedRangesMs:[[500,900],[100,200]],updatedAt:"2026-09-28T08:00:00.000Z"}]}}});
  assert.equal(ranges.statusCode,400);await app.close();
});
