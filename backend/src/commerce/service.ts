import type { Pool } from 'pg';
import { ApiError } from '../api/errors.ts';

export class CommerceService {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool=pool; }
  async bundles() {
    return (await this.pool.query('SELECT id AS "bundleId",version,title,price_fen AS "amountFen",currency,mode,contents FROM content_bundles ORDER BY id,version')).rows;
  }
  async createOrder(userId: string, bundleId: string, version: number, key: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [userId + ':' + key]);
      const existing = (await client.query('SELECT * FROM purchase_orders WHERE user_id=$1 AND idempotency_key=$2', [userId,key])).rows[0];
      if (existing) {
        if (existing.bundle_id !== bundleId || existing.bundle_version !== version) throw new ApiError('IDEMPOTENCY_KEY_REUSED',409,false,'Order key already used for another bundle');
        await client.query('COMMIT'); return this.view(existing);
      }
      const bundle = (await client.query('SELECT * FROM content_bundles WHERE id=$1 AND version=$2', [bundleId,version])).rows[0];
      if (!bundle) throw new ApiError('RESOURCE_NOT_FOUND',404,false,'Bundle not found');
      const order = (await client.query(`INSERT INTO purchase_orders(user_id,bundle_id,bundle_version,idempotency_key,title,amount_fen,currency,contents)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [userId,bundleId,version,key,bundle.title,bundle.price_fen,bundle.currency,JSON.stringify(bundle.contents)])).rows[0];
      await client.query('COMMIT'); return this.view(order);
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async orders(userId: string) {
    return (await this.pool.query('SELECT * FROM purchase_orders WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [userId])).rows.map(row=>this.view(row));
  }
  async order(userId: string, id: string) {
    const row = (await this.pool.query('SELECT * FROM purchase_orders WHERE user_id=$1 AND id=$2',[userId,id])).rows[0];
    if (!row) throw new ApiError('RESOURCE_NOT_FOUND',404,false,'Order not found');
    return this.view(row);
  }
  async canAccess(userId: string, pieceId: string, version: number) {
    const result = await this.pool.query(`SELECT 1 FROM purchase_orders WHERE user_id=$1 AND status='paid'
      AND contents @> $2::jsonb LIMIT 1`, [userId,JSON.stringify([{pieceId,contentVersion:version}])]);
    return result.rows.length>0;
  }
  // Invoked only by the local CLI, never exposed as a client HTTP route.
  async simulate(orderId: string, action: 'pay'|'refund', eventKey: string, amountFen: number) {
    if (!eventKey || eventKey.length>128 || !Number.isInteger(amountFen) || amountFen<=0) throw new ApiError('INVALID_REQUEST',400,false,'Invalid simulated event');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[eventKey]);
      const order = (await client.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE',[orderId])).rows[0];
      if (!order) throw new ApiError('RESOURCE_NOT_FOUND',404,false,'Order not found');
      if (order.amount_fen!==amountFen) throw new ApiError('CONFLICT',409,false,'Amount must match full order amount');
      const event = (await client.query('SELECT * FROM simulated_payment_events WHERE event_key=$1',[eventKey])).rows[0];
      if (event && (event.order_id!==orderId || event.action!==action || event.amount_fen!==amountFen)) throw new ApiError('IDEMPOTENCY_KEY_REUSED',409,false,'Event key reused');
      if (!event) {
        if ((action==='pay' && order.status==='refunded') || (action==='refund' && order.status==='pending')) throw new ApiError('CONFLICT',409,false,'Invalid simulated transition');
        await client.query('INSERT INTO simulated_payment_events(event_key,order_id,action,amount_fen) VALUES($1,$2,$3,$4)',[eventKey,orderId,action,amountFen]);
        if (action==='pay' && order.status==='pending') await client.query("UPDATE purchase_orders SET status='paid',paid_at=now() WHERE id=$1",[orderId]);
        if (action==='refund' && order.status==='paid') await client.query("UPDATE purchase_orders SET status='refunded',refunded_at=now() WHERE id=$1",[orderId]);
      }
      const current=(await client.query('SELECT * FROM purchase_orders WHERE id=$1',[orderId])).rows[0];
      await client.query('COMMIT'); return this.view(current);
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  private view(row: any) {
    return {orderId:row.id,bundleId:row.bundle_id,bundleVersion:row.bundle_version,title:row.title,amountFen:row.amount_fen,currency:row.currency,mode:row.mode,status:row.status,contents:row.contents,createdAt:row.created_at,paidAt:row.paid_at,refundedAt:row.refunded_at};
  }
}
