import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { ApiError } from "../src/api/errors.ts";
import { RankingQueryService } from "../src/ranking/query-service.ts";

const cursorKey = "dGluZ3l1ZS1sb2NhbC1pZGVudC1rZXktMzJieXRlcyE=";
const now = new Date("2026-09-24T05:00:00.000Z");

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
  const service = new RankingQueryService(emptyRankingPool(), cursorKey, () => now);
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
  const service = new RankingQueryService(emptyRankingPool(), cursorKey, () => now);
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
