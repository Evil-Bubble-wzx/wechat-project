import type { Pool } from "pg";

export type AuditRecord = {
  actorType: "user" | "admin" | "service" | "worker";
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  beforeState?: unknown;
  afterState?: unknown;
  metadata?: Record<string, unknown>;
};

export class AuditService {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async record(record: AuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (
         actor_type, actor_id, action, target_type, target_id, request_id,
         before_state, after_state, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        record.actorType,
        record.actorId,
        record.action,
        record.targetType,
        record.targetId,
        record.requestId,
        record.beforeState === undefined ? null : JSON.stringify(record.beforeState),
        record.afterState === undefined ? null : JSON.stringify(record.afterState),
        JSON.stringify(record.metadata ?? {}),
      ],
    );
  }
}
