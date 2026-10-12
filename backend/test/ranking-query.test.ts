import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { ApiError } from "../src/api/errors.ts";
import { RankingQueryService } from "../src/ranking/query-service.ts";
import type { RankingAggregationService, RankingDimensions } from "../src/ranking/aggregation-service.ts";

const cursorKey = "dGluZ3l1ZS1sb2NhbC1pZGVudC1rZXktMzJieXRlcyE=";
const now = new Date("2026-09-24T05:00:00.000Z");
const emptyAggregation:Pick<RankingAggregationService,"build">={async build(){return {snapshotId:"11111111-1111-4111-8111-111111111111",status:"cohort_too_small",cohortSize:0,minimumCohortSize:10,generatedAt:now.toISOString(),entries:[]}}};

function emptyRankingPool(): Pool {
  return {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("FROM campuses WHERE id=$1")) {
        return { rows: [{ exists: params?.[0] === "a" || params?.[0] === "b" }] };
      }
      if (sql.includes("FROM ranking_snapshots")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof ApiError && error.code === code);
}

test("all supported campus, period, grade and level filter combinations normalize successfully", async () => {
  const service = new RankingQueryService(emptyRankingPool(), cursorKey, () => now, emptyAggregation);
  const periods = [
    { periodType: "rolling7" as const },
    { periodType: "week" as const, periodKey: "2026-W39" },
    { periodType: "week" as const, periodKey: "2026-W38" },
    { periodType: "month" as const, periodKey: "2026-09" },
    { periodType: "month" as const, periodKey: "2026-08" },
    { periodType: "year" as const, periodKey: "2026" },
  ];
  const grades = ["all", "k", ...Array.from({ length: 9 }, (_, index) => String(index + 1))];
  const levels = ["all", ...Array.from({ length: 5 }, (_, index) => String(index + 1))];
  let combinations = 0;
  for (const campusId of ["a", "b"]) {
    for (const period of periods) {
      for (const grade of grades) {
        for (const level of levels) {
          const response = await service.rankings(
            "11111111-1111-4111-8111-111111111111",
            { campusId, ...period, grade, level },
            undefined,
            20,
          );
          assert.equal(response.status, "unavailable");
          assert.equal(response.filters.campusId, campusId);
          combinations += 1;
        }
      }
    }
  }
  assert.equal(combinations, 792);
});

test("ranking filters reject unknown campuses, malformed keys and future periods", async () => {
  const service = new RankingQueryService(emptyRankingPool(), cursorKey, () => now, emptyAggregation);
  const userId = "11111111-1111-4111-8111-111111111111";
  await expectCode(service.rankings(userId, { campusId: "c", periodType: "rolling7" }, undefined, 20), "RANKING_FILTER_INVALID");
  await expectCode(service.rankings(userId, { campusId: "a", periodType: "week", periodKey: "2026-W54" }, undefined, 20), "RANKING_PERIOD_INVALID");
  await expectCode(service.rankings(userId, { campusId: "a", periodType: "week", periodKey: "2025-W53" }, undefined, 20), "RANKING_PERIOD_INVALID");
  await expectCode(service.rankings(userId, { campusId: "a", periodType: "week", periodKey: "2026-W40" }, undefined, 20), "RANKING_PERIOD_INVALID");
  await expectCode(service.rankings(userId, { campusId: "a", periodType: "month", periodKey: "2026-13" }, undefined, 20), "RANKING_PERIOD_INVALID");
  await expectCode(service.rankings(userId, { campusId: "a", periodType: "year", periodKey: "2027" }, undefined, 20), "RANKING_PERIOD_INVALID");
  await expectCode(service.rankings(userId, { campusId: "a", periodType: "rolling7", periodKey: "2026-W39" }, undefined, 20), "RANKING_PERIOD_INVALID");
  await expectCode(service.rankings(userId, { campusId: "a", periodType: "rolling7", grade: "10" }, undefined, 20), "RANKING_FILTER_INVALID");
  await expectCode(service.rankings(userId, { campusId: "a", periodType: "rolling7", level: "6" }, undefined, 20), "RANKING_FILTER_INVALID");
});

test("rolling rankings age out idle snapshots and keep pagination and detail pinned",async()=>{
  let clock=new Date("2026-10-10T05:00:12.000Z"),builds=0;
  const snapshots=new Map<string,any>();
  const staleId="00000000-0000-4000-8000-000000000001";
  snapshots.set(staleId,{id:staleId,period_type:"rolling7",period_key:"2026-09-13/2026-09-20",starts_at:new Date("2026-09-13"),ends_at:new Date("2026-09-20"),rule_version:"learning-points-v2",result_status:"ready",cohort_size:10,minimum_cohort_size:10,generated_at:new Date("2026-09-20")});
  const entry={rank:1,participant_id:"reader_test_1",display_name:"Reader 1",score:"70",profile_grade:"3",profile_reading_level:"3",user_id:"11111111-1111-4111-8111-111111111111",score_breakdown:[],stats:{}};
  const pool={
    async query(sql:string,params:any[]=[]){
      if(sql.includes("FROM campuses"))return {rows:[{exists:params[0]==="a"}]};
      if(sql.includes("FROM ranking_snapshots")){
        const rows=[...snapshots.values()].filter(row=>params[0]==="a"&&(params[6]?row.id===params[6]:row.starts_at.getTime()===params[7].getTime()&&row.ends_at.getTime()===params[8].getTime()));
        return {rows:rows.slice(-1)};
      }
      if(sql.includes("FROM ranking_snapshot_entries"))return {rows:sql.includes("rank>$2")?(params[1]?[]:[entry,{...entry,rank:2,participant_id:"reader_test_2"}]):[entry]};
      if(sql.includes("FROM ranking_snapshot_quizzes"))return {rows:[]};
      throw new Error(sql);
    }
  } as unknown as Pool;
  const aggregation:Pick<RankingAggregationService,"build">={async build(dimensions:RankingDimensions){
    builds+=1;const id=`00000000-0000-4000-8000-${String(builds+1).padStart(12,"0")}`;
    snapshots.set(id,{id,period_type:"rolling7",period_key:dimensions.periodKey,starts_at:new Date(dimensions.startsAt),ends_at:new Date(dimensions.endsAt),rule_version:"learning-points-v2",result_status:"ready",cohort_size:10,minimum_cohort_size:10,generated_at:clock});
    return {snapshotId:id,status:"ready",cohortSize:10,minimumCohortSize:10,generatedAt:clock.toISOString(),entries:[]};
  }};
  const service=new RankingQueryService(pool,cursorKey,()=>clock,aggregation);
  const filters={campusId:"a",periodType:"rolling7" as const};
  const first=await service.rankings(entry.user_id,filters,undefined,1);
  assert.equal(builds,1);assert.notEqual(first.snapshotId,staleId);
  assert.equal(first.endsAt,"2026-10-10T05:00:00.000Z");assert.equal(first.startsAt,"2026-10-03T05:00:00.000Z");
  await service.rankings(entry.user_id,filters,undefined,1);assert.equal(builds,1,"same bucket uses cached snapshot");
  clock=new Date(clock.getTime()+31_000);
  const next=await service.rankings(entry.user_id,filters,undefined,1);assert.equal(builds,2);assert.notEqual(next.snapshotId,first.snapshotId);
  const continued=await service.rankings(entry.user_id,filters,first.nextCursor!,1);assert.equal(continued.snapshotId,first.snapshotId);assert.equal(builds,2);
  const detail=await service.detail(filters,entry.participant_id,undefined,20,first.snapshotId!);assert.equal(detail.snapshotId,first.snapshotId);assert.equal(detail.endsAt,first.endsAt);
  await expectCode(service.rankings(entry.user_id,{campusId:"b",periodType:"rolling7"},first.nextCursor!,1),"RANKING_FILTER_INVALID");
  await expectCode(service.detail(filters,entry.participant_id,undefined,20,"not-a-uuid"),"INVALID_REQUEST");
});
