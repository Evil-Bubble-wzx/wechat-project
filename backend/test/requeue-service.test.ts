import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { RequeueService, type RecoveryQueuePort } from "../src/recovery/requeue-service.ts";

test("database facts rebuild missing queue jobs without duplicating existing jobs", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("SELECT job.id")) return { rows: [{ id: "job-1" }, { id: "job-2" }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const added: Array<{ name: string; payload: unknown; options: Record<string, unknown> }> = [];
  const queue: RecoveryQueuePort = {
    async getJob(jobId: string) { return jobId === "ingestion-job-1" ? { id: jobId } : null; },
    async add(name, payload, options) { added.push({ name, payload, options }); return {}; },
  };
  const result = await new RequeueService(pool, queue).rebuild("recovery-request");
  assert.deepEqual(result, { candidates: 2, enqueued: 1, alreadyPresent: 1 });
  assert.equal(queries.length, 2);
  assert.deepEqual(added[0], {
    name: "content.ingestion.item",
    payload: { type: "content.ingestion.item", processingJobId: "job-2", requestId: "recovery-request" },
    options: {
      jobId: "ingestion-job-2",
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    },
  });
});
