import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {createApp} from "../src/api/app.ts";
import {ApiError} from "../src/api/errors.ts";
import type {SessionServicePort} from "../src/api/session-routes.ts";
import {libraryOperationIdFor,type LibrarySyncInput} from "../src/sync/reader-library-service.ts";
const userId="11111111-1111-4111-8111-111111111111";
const sessions={async authenticateAccessToken(token:string){if(token!=="test-token")throw new ApiError("UNAUTHENTICATED",401,false,"Invalid token");return {userId,sessionId:"22222222-2222-4222-8222-222222222222"}}} as SessionServicePort;
const payload={workId:"peter-rabbit",action:"favorite" as const,baseRevision:"0",occurredAt:"2026-10-10T05:00:00.000Z"};
const input:LibrarySyncInput={schemaVersion:1,batchId:"library-test-001",cursor:null,operations:[{operationId:libraryOperationIdFor(payload),...payload}],limit:100};
test("library client and server freeze the same operation identity",()=>{
  const require=createRequire(import.meta.url);
  const client=require("../../miniprogram/modules/sync/library-sync.js");
  assert.equal(client.operationIdFor(payload),libraryOperationIdFor(payload));
});
test("library authenticates before parsing and forwards only account-scoped fields",async()=>{
  let captured:unknown;
  const app=createApp({sessionService:sessions,readerLibraryService:{async sync(id,request){captured={id,request};return {schemaVersion:1,batchId:request.batchId,serverTime:new Date().toISOString(),operations:[],changes:[],nextCursor:"cursor",hasMore:false}}}});
  const headers={authorization:"Bearer test-token","idempotency-key":input.batchId};
  try{
    assert.equal((await app.inject({method:"POST",url:"/api/v1/me/library/sync",payload:input})).statusCode,401);
    const response=await app.inject({method:"POST",url:"/api/v1/me/library/sync",headers,payload:input});
    assert.equal(response.statusCode,200);assert.deepEqual(captured,{id:userId,request:input});assert.ok(response.json().requestId);
    for(const invalid of [{...input,userId:"other"},{...input,operations:[{...input.operations[0],points:100}]},{...input,cursor:12},{...input,limit:101},{...input,operations:[{...input.operations[0],occurredAt:"not-a-date"}]}]){
      assert.equal((await app.inject({method:"POST",url:"/api/v1/me/library/sync",headers,payload:invalid})).statusCode,400);
    }
    assert.equal((await app.inject({method:"POST",url:"/api/v1/me/library/sync",headers:{...headers,"idempotency-key":"another"},payload:input})).statusCode,400);
  }finally{await app.close()}
});
