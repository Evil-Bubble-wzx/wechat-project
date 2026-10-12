import assert from "node:assert/strict";
import test from "node:test";
import type {Pool} from "pg";
import {RequeueService,type RecoveryQueuePort} from "../src/recovery/requeue-service.ts";
test("recovery rejects invalid stale thresholds before reading or changing facts",async()=>{
 let queries=0;const pool={query:async()=>{queries++;throw Error("Unexpected query");}} as unknown as Pool;
 const queue={getJob:async()=>null,add:async()=>{throw Error("Unexpected dispatch");}} as RecoveryQueuePort;
 for(const value of [0,-1,1.5,1441])await assert.rejects(new RequeueService(pool,queue).rebuild("request",value));assert.equal(queries,0);
});
