import { LEARNING_POINT_RULES } from "../src/ranking/score.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { AuthenticatedSession, CurrentUser, SessionTokenResponse } from "../src/auth/session-service.ts";
import { createApp } from "../src/api/app.ts";
import type { RankingServicePort } from "../src/api/ranking-routes.ts";
import type { SessionServicePort } from "../src/api/session-routes.ts";

class RankingSession implements SessionServicePort{
  async createWechatSession():Promise<SessionTokenResponse>{throw new Error("unused")}
  async refreshSession():Promise<SessionTokenResponse>{throw new Error("unused")}
  async authenticateAccessToken(token:string):Promise<AuthenticatedSession>{assert.equal(token,"ranking-token");return {userId:"11111111-1111-4111-8111-111111111111",sessionId:"22222222-2222-4222-8222-222222222222"}}
  async revokeSession():Promise<void>{throw new Error("unused")}
  async getCurrentUser():Promise<CurrentUser>{throw new Error("unused")}
}

class FakeRanking implements RankingServicePort{
  public lastCall:unknown=null;
  async options(){return {timezone:"Asia/Shanghai",minimumCohortSize:10,ruleVersion:"learning-points-v2",scoreRules:LEARNING_POINT_RULES,scoreCap:null,campuses:[{value:"a",label:"A校区"}],periodTypes:[],periods:{week:[],month:[]},grades:[],levels:[]}}
  async rankings(userId:string,input:never,cursor:string|undefined,limit:number){this.lastCall={userId,input,cursor,limit};return {snapshotId:null,status:"unavailable" as const,timezone:"Asia/Shanghai",filters:{campusId:"a",periodType:"rolling7" as const,periodKey:"2026-09-18/2026-09-25",grade:null,level:null},ruleVersion:"learning-points-v2",periodType:"rolling7" as const,periodKey:"2026-09-18/2026-09-25",startsAt:"2026-09-18T00:00:00.000Z",endsAt:"2026-09-25T00:00:00.000Z",generatedAt:null,minimumCohortSize:10,cohortSize:0,items:[],currentUser:null,nextCursor:null}}
  async detail(input:never,participantId:string,cursor:string|undefined,limit:number){this.lastCall={input,participantId,cursor,limit};return {snapshotId:"00000000-0000-4000-8000-000000000002",ruleVersion:"learning-points-v2",participant:{participantId,displayName:"Reader 01",gradeLabel:"Grade 3",readingLevelLabel:"Lv 3.x"},periodType:"week" as const,periodKey:"2026-W39",startsAt:"2026-09-21T16:00:00.000Z",endsAt:"2026-09-28T16:00:00.000Z",rankingScore:"700",scoreBreakdown:[],stats:{},quizzes:[],nextCursor:null}}
}

test("ranking routes require authentication",async()=>{
  const app=createApp({sessionService:new RankingSession(),rankingService:new FakeRanking()});
  const response=await app.inject({method:"GET",url:"/api/v1/ranking-options"});
  assert.equal(response.statusCode,401);
  assert.equal(response.json().error.code,"UNAUTHENTICATED");
  await app.close();
});

test("ranking options and unavailable ranking responses preserve request IDs",async()=>{
  const ranking=new FakeRanking(),app=createApp({sessionService:new RankingSession(),rankingService:ranking});
  const headers={authorization:"Bearer ranking-token"};
  const options=await app.inject({method:"GET",url:"/api/v1/ranking-options",headers});
  assert.equal(options.statusCode,200);
  assert.equal(options.json().ruleVersion,"learning-points-v2");
  assert.equal(options.json().timezone,"Asia/Shanghai");
  const list=await app.inject({method:"GET",url:"/api/v1/rankings?campusId=a&periodType=rolling7&grade=all&level=all&limit=25",headers});
  assert.equal(list.statusCode,200);
  assert.equal(list.json().status,"unavailable");
  assert.match(list.json().requestId,/^[0-9a-f-]{36}$/);
  assert.deepEqual(ranking.lastCall,{userId:"11111111-1111-4111-8111-111111111111",input:{campusId:"a",periodType:"rolling7",periodKey:undefined,grade:"all",level:"all"},cursor:undefined,limit:25});
  await app.close();
});

test("ranking detail validates participant and forwards pagination",async()=>{
  const ranking=new FakeRanking(),app=createApp({sessionService:new RankingSession(),rankingService:ranking});
  const headers={authorization:"Bearer ranking-token"};
  const invalid=await app.inject({method:"GET",url:"/api/v1/rankings/short/quizzes?campusId=a&periodType=week&periodKey=2026-W39",headers});
  assert.equal(invalid.statusCode,400);
  const detail=await app.inject({method:"GET",url:"/api/v1/rankings/participant-001/quizzes?campusId=a&periodType=week&periodKey=2026-W39&cursor=next-page&limit=5",headers});
  assert.equal(detail.statusCode,200);
  assert.equal(detail.json().rankingScore,"700");
  assert.deepEqual(ranking.lastCall,{input:{campusId:"a",periodType:"week",periodKey:"2026-W39",grade:undefined,level:undefined},participantId:"participant-001",cursor:"next-page",limit:5});
  await app.close();
});

test("analysis requires authentication and a snapshot and validates search-sort input",async()=>{
  const ranking:any=new FakeRanking();let calls=0;
  ranking.analysis=async()=>{calls++;return {snapshotId:"00000000-0000-4000-8000-000000000002",quizzes:[],search:{sort:"date",direction:"desc"}}};
  const app=createApp({sessionService:new RankingSession(),rankingService:ranking});
  try{
    const root="/api/v1/rankings/participant-001/quiz-analysis?campusId=a&periodType=rolling7",headers={authorization:"Bearer ranking-token"};
    assert.equal((await app.inject({method:"GET",url:root})).statusCode,401);
    assert.equal((await app.inject({method:"GET",url:root,headers})).statusCode,400);
    const pinned=root+"&snapshotId=00000000-0000-4000-8000-000000000002";
    for(const tail of ["&sort=user_id","&direction=invalid","&query="+encodeURIComponent("x".repeat(129)),"&query=a&query=b","&snapshotId=x"]){
      assert.equal((await app.inject({method:"GET",url:pinned+tail,headers})).statusCode,400);
    }
    assert.equal(calls,0);
  }finally{await app.close()}
});
test("analysis forwards normalized options without exposing the literal search in audit metadata",async()=>{
  const ranking:any=new FakeRanking();let received:any[],auditRecord:any;
  ranking.analysis=async(...args:any[])=>{received=args;return {snapshotId:"00000000-0000-4000-8000-000000000002",quizzes:[],search:args[5]}};
  const app=createApp({sessionService:new RankingSession(),rankingService:ranking,auditService:{record:async(record:unknown)=>{auditRecord=record}} as any});
  try{
    const response=await app.inject({method:"GET",url:"/api/v1/rankings/participant-001/quiz-analysis?campusId=a&periodType=rolling7&snapshotId=00000000-0000-4000-8000-000000000002&query=%20Author%20&sort=words&direction=asc",headers:{authorization:"Bearer ranking-token"}});
    assert.equal(response.statusCode,200);assert.equal(received![1],"participant-001");assert.deepEqual(received![5],{query:"Author",sort:"words",direction:"asc"});
    assert.match(response.json().requestId,/^[0-9a-f-]{36}$/);
    assert.equal(auditRecord.action,"ranking_analysis_read");assert.equal(auditRecord.requestId,response.json().requestId);
    assert.deepEqual(auditRecord.metadata,{resultCount:0,sort:"words",direction:"asc"});
    assert.equal(JSON.stringify(auditRecord).includes("Author"),false);
  }finally{await app.close()}
});
