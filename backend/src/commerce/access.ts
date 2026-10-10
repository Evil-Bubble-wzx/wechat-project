import type { Pool } from 'pg';
import { ApiError } from '../api/errors.ts';

export async function hasPurchasedVersion(query: Pick<Pool,'query'>,userId:string|undefined,pieceId:string,version:number,simulation=false) {
  if(!simulation||!userId)return false;
  return (await query.query("SELECT id FROM purchase_orders WHERE user_id=$1 AND status='paid' AND contents @> $2::jsonb LIMIT 1",[userId,JSON.stringify([{pieceId,contentVersion:version}])])).rows.length>0;
}

// Call inside the learning transaction: the shared order lock serializes refunds
// with new writes. Free resources never depend on the simulation tables.
export async function assertContentAccess(query: Pick<Pool, 'query'>, userId: string | undefined, pieceId: string, version: number, simulation = false, lock = false) {
  const resource = (await query.query(`SELECT p.access_type AS piece_access,w.access_type AS work_access
    FROM pieces p JOIN works w ON w.id=p.work_id
    WHERE p.id=$1 AND p.status='published' AND w.status='published'`, [pieceId])).rows[0];
  if (!resource) throw new ApiError('RESOURCE_NOT_FOUND',404,false,'Published content not found');
  if (resource.piece_access==='free' && resource.work_access==='free') return;
  if (simulation && userId) {
    const grants = await query.query(`SELECT id FROM purchase_orders WHERE user_id=$1 AND status='paid'
      AND contents @> $2::jsonb ORDER BY id ${lock ? 'FOR SHARE' : ''}`,
      [userId,JSON.stringify([{pieceId,contentVersion:version}])]);
    if (grants.rows.length) return;
  }
  throw new ApiError('CONTENT_ACCESS_DENIED',403,false,'A valid purchase for this content version is required');
}
