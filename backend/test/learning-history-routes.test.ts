import assert from "node:assert/strict";
import test from "node:test";
import {createApp} from "../src/api/app.ts";
import {ApiError} from "../src/api/errors.ts";
import type {SessionServicePort} from "../src/api/session-routes.ts";
import {quizTrend,type LearningSummary} from "../src/quiz/history-service.ts";
const userId="11111111-1111-4111-8111-111111111111";
const sessions={async authenticateAccessToken(token:string){if(token!=="test-token")throw new ApiError("UNAUTHENTICATED",401,false,"Invalid token");return {userId,sessionId:"22222222-2222-4222-8222-222222222222"}}} as SessionServicePort;
test("learning history authenticates first and rejects account or malformed query injection",async()=>{
  let captured:unknown;
  const app=createApp({sessionService:sessions,learningHistoryService:{
    async history(id,cursor,limit){captured={id,cursor,limit};return {schemaVersion:1,serverTime:new Date().toISOString(),changes:[],nextCursor:"cursor",hasMore:false}},
    async summary(id){captured={id};return {} as LearningSummary},
  }});
  try{
    const headers={authorization:"Bearer test-token"};
    assert.equal((await app.inject({url:"/api/v1/me/quiz-history?userId=other"})).statusCode,401);
    const result=await app.inject({url:"/api/v1/me/quiz-history?cursor=abc&limit=2",headers});
    assert.equal(result.statusCode,200);assert.deepEqual(captured,{id:userId,cursor:"abc",limit:2});
    assert.equal(result.headers["x-api-contract-version"],"api-contract-v2.4.0");
    for(const query of ["userId=other","limit=0","limit=101","limit=1.2","limit=01","limit=-1","cursor=","cursor="+encodeURIComponent("x".repeat(513))]){
      assert.equal((await app.inject({url:"/api/v1/me/quiz-history?"+query,headers})).statusCode,400,query);
    }
    assert.equal((await app.inject({url:"/api/v1/me/learning-summary",headers})).statusCode,200);assert.deepEqual(captured,{id:userId});
    assert.equal((await app.inject({url:"/api/v1/me/learning-summary?score=999",headers})).statusCode,400);
    assert.equal((await app.inject({url:"/api/v1/me/learning-summary"})).statusCode,401);
  }finally{await app.close()}
});
test("server Quiz trend requires six distinct compatible pieces and uses server ordering",()=>{
  assert.deepEqual(quizTrend([0,50]),{ready:false,remaining:4,early:null,recent:null,delta:null,pieceCount:2});
  assert.deepEqual(quizTrend([0,50,100,100,100,100]),{ready:true,remaining:0,early:25,recent:100,delta:75,pieceCount:6});
  assert.deepEqual(quizTrend([100,100,100,100,50,0]),{ready:true,remaining:0,early:100,recent:25,delta:-75,pieceCount:6});
});
test("learning history routes require explicit authenticated session dependency",()=>{
  assert.throws(()=>createApp({learningHistoryService:{} as any}),/require a session service/);
});
