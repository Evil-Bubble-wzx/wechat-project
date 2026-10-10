import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export const fixturePiece='commerce-test-piece';
export const fixtureBundle='commerce-test-bundle';
export const fixtureText='This is an original test passage. A small bird finds a blue stone. The bird leaves the stone by a tree.';
export const fixtureAssets=[{type:'text',bytes:Buffer.from(fixtureText),mime:'text/plain'},
  {type:'audio',bytes:(()=>{const b=Buffer.alloc(44+8000*2*10);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;})(),mime:'audio/wav'}];
export async function seedCommerceFixture(pool:Pool,bucket:string){
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('commerce-fixture-v1'))");
    if ((await client.query('SELECT 1 FROM content_bundles WHERE id=$1 AND version=1',[fixtureBundle])).rows.length){await client.query('COMMIT');return;}
    await client.query("INSERT INTO works(id,title,status,access_type) VALUES ('commerce-test','模拟内容包 · 不收费','published','restricted')");
    await client.query("INSERT INTO pieces(id,work_id,title,status,access_type) VALUES ($1,'commerce-test','Original test passage','published','restricted')",[fixturePiece]);
    const v=(await client.query("INSERT INTO content_versions(piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ($1,1,'published',true,$2,now()) RETURNING id",[fixturePiece,createHash('sha256').update(fixtureText).digest('hex')])).rows[0];
    await client.query('UPDATE pieces SET current_content_version_id=$1 WHERE id=$2',[v.id,fixturePiece]);
    for(const a of fixtureAssets)await client.query("INSERT INTO content_assets(piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,'published')",[fixturePiece,a.type,bucket,`commerce-fixture/v1/${a.type}`,createHash('sha256').update(a.bytes).digest('hex'),a.bytes.length,a.mime,a.type==='audio'?10000:null]);
    const q=(await client.query("INSERT INTO quiz_packages(piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES ($1,1,1,$2,'published',80,now()) RETURNING id",[fixturePiece,'c'.repeat(64)])).rows[0];
    await client.query("INSERT INTO quiz_questions(quiz_package_id,question_id,prompt,options,correct_option,sort_order) VALUES ($1,'test-q1','What does the bird find?','[\"A blue stone\",\"A red cup\"]',0,0)",[q.id]);
    await client.query('INSERT INTO content_bundles(id,version,title,price_fen,contents) VALUES ($1,1,$2,100,$3)',[fixtureBundle,'模拟内容包 · 不收费',JSON.stringify([{pieceId:fixturePiece,contentVersion:1}])]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
