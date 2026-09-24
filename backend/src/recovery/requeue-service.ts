import type { Pool } from "pg";

import type { IngestionJobPayload } from "../ingestion/service.ts";

export interface RecoveryQueuePort {
  getJob(jobId: string): Promise<unknown | null>;
  add(
    name: string,
    payload: IngestionJobPayload,
    options: Record<string, unknown>,
  ): Promise<unknown>;
}

export class RequeueService {
  private readonly pool: Pool;
  private readonly queue: RecoveryQueuePort;
  constructor(pool: Pool, queue: RecoveryQueuePort) {
    this.pool = pool;
    this.queue = queue;
  }

  async rebuild(requestId: string, staleAfterMinutes = 10): Promise<{ candidates: number; enqueued: number; alreadyPresent: number }> {
    if (!Number.isInteger(staleAfterMinutes) || staleAfterMinutes < 1 || staleAfterMinutes > 1440) {
      throw new Error("staleAfterMinutes must be between 1 and 1440");
    }
    await this.pool.query(
      `UPDATE processing_jobs job
       SET status='queued', worker_id=NULL, next_retry_at=NULL, updated_at=now()
       FROM ingestion_items item, ingestion_batches batch
       WHERE job.ingestion_item_id=item.id AND item.batch_id=batch.id
         AND job.status='running'
         AND job.updated_at < now() - make_interval(mins => $1)
         AND item.status <> 'cancelled' AND batch.status <> 'cancelled'`,
      [staleAfterMinutes],
    );
    const result = await this.pool.query<{ id: string }>(
      `SELECT job.id
       FROM processing_jobs job
       JOIN ingestion_items item ON item.id=job.ingestion_item_id
       JOIN ingestion_batches batch ON batch.id=item.batch_id
       WHERE (
         job.status='queued'
         OR (job.status='retry_wait' AND (job.next_retry_at IS NULL OR job.next_retry_at <= now()))
       )
         AND item.status <> 'cancelled' AND batch.status <> 'cancelled'
       ORDER BY job.created_at`,
    );
    let enqueued = 0;
    let alreadyPresent = 0;
    for (const { id } of result.rows) {
      const bullJobId = `ingestion-${id}`;
      if (await this.queue.getJob(bullJobId)) {
        alreadyPresent += 1;
        continue;
      }
      await this.queue.add(
        "content.ingestion.item",
        { type: "content.ingestion.item", processingJobId: id, requestId },
        {
          jobId: bullJobId,
          attempts: 5,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: 1_000,
          removeOnFail: 5_000,
        },
      );
      enqueued += 1;
    }
    return { candidates: result.rows.length, enqueued, alreadyPresent };
  }
}
