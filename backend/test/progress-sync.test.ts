import assert from "node:assert/strict";
import test from "node:test";

import { progressSyncInternals } from "../src/sync/progress-sync-service.ts";

test("progress range merging is bounded, ordered and exact",()=>{
  assert.deepEqual(progressSyncInternals.mergeRanges([[100,200],[0,50],[240,400],[-10,20],[900,1200]],1000),[[0,400],[900,1000]]);
});

test("completion requires ninety percent and the tail",()=>{
  assert.deepEqual(progressSyncInternals.derived([[0,9000]],10000),{listenedMs:9000,coverage:.9,completed:false});
  assert.equal(progressSyncInternals.derived([[0,7000],[7000,10000]],10000).completed,true);
  assert.equal(progressSyncInternals.derived([],10000,true).completed,true);
});

test("progress cursors round trip and reject malformed input",()=>{
  const cursor=progressSyncInternals.encodeCursor("peter-rabbit-01");
  assert.equal(progressSyncInternals.decodeCursor(cursor),"peter-rabbit-01");
  assert.throws(()=>progressSyncInternals.decodeCursor("not-json"));
});
