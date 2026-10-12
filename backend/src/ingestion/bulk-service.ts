import {createHash,randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {ApiError} from "../api/errors.ts";
import type {BulkPlan} from "./bulk-plan.ts";
const conflict=(message:string)=>new ApiError("INGESTION_BATCH_CONFLICT",409,false,message);
export class BulkImportService{
 private pool:Pool;
 constructor(pool:Pool){this.pool=pool;}
 private async admin(client:PoolClient,actor:string){const roles=await client.query("SELECT r.role FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=$1 AND u.status='active' AND r.role IN ('content_admin','operations_admin') FOR SHARE OF u,r",[actor]);if(!roles.rowCount)throw new ApiError("FORBIDDEN",403,false,"Active content administrator required");}
 async create(plan:BulkPlan,actor:string,key:string,requestId:string){
  const hash=createHash("sha256").update(JSON.stringify(plan)).digest("hex"),client=await this.pool.connect();let groupId="";
  try{
   await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["bulk-import:"+actor+":"+key]);
   const previous=(await client.query<{id:string;request_hash:string}>("SELECT id,request_hash FROM content_import_groups WHERE actor_user_id=$1 AND idempotency_key=$2",[actor,key])).rows[0];
   if(previous){await this.admin(client,actor);if(previous.request_hash.trim()!==hash)throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"Bulk import key belongs to another declaration");groupId=previous.id;await client.query("COMMIT");}
   else{
    for(const work of [...plan.works].sort((a,b)=>a.workId<b.workId?-1:a.workId>b.workId?1:0))await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["catalog-work:"+work.workId]);
    // Lock all global chapter IDs in a common order, even across different works.
    for(const id of plan.works.flatMap(work=>work.pieces.map(piece=>piece.pieceId)).sort())await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["catalog-piece:"+id]);
    await this.admin(client,actor);let createdWorks=0,createdPieces=0;
    for(const work of plan.works){
     const existing=(await client.query("SELECT title,description,access_type,status FROM works WHERE id=$1 FOR UPDATE",[work.workId])).rows[0];
     if(existing){if(existing.status==="archived"||existing.title!==work.title||existing.description!==work.description||existing.access_type!==work.accessType)throw conflict("Existing work attributes differ; original catalog is not overwritten");}
     else{await client.query("INSERT INTO works(id,title,description,access_type,status) VALUES($1,$2,$3,$4,'draft')",[work.workId,work.title,work.description,work.accessType]);createdWorks++;}
     for(const piece of work.pieces){
      const old=(await client.query("SELECT work_id,title,sort_order,access_type,status FROM pieces WHERE id=$1 FOR UPDATE",[piece.pieceId])).rows[0];
      if(old){if(old.status==="archived"||old.work_id!==work.workId||old.title!==piece.title||old.sort_order!==piece.sortOrder||old.access_type!==piece.accessType)throw conflict("Existing chapter attributes differ; original chapter is not overwritten");}
      else{await client.query("INSERT INTO pieces(id,work_id,title,sort_order,access_type,status) VALUES($1,$2,$3,$4,$5,'draft')",[piece.pieceId,work.workId,piece.title,piece.sortOrder,piece.accessType]);createdPieces++;}
      if((await client.query("SELECT id FROM ingestion_batches WHERE piece_id=$1 AND content_version=$2 UNION ALL SELECT id FROM content_versions WHERE piece_id=$1 AND content_version=$2 LIMIT 1",[piece.pieceId,piece.contentVersion])).rowCount)throw conflict("Chapter version has import history; use a new content version");
     }
    }
    groupId=randomUUID();const count=plan.works.reduce((sum,work)=>sum+work.pieces.length,0),bytes=plan.works.reduce((sum,work)=>sum+work.pieces.reduce((n,piece)=>n+piece.items.reduce((n,item)=>n+item.sizeBytes,0),0),0);
    await client.query("INSERT INTO content_import_groups(id,actor_user_id,idempotency_key,request_hash,plan,work_count,piece_count,declared_bytes,created_work_count,created_piece_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[groupId,actor,key,hash,JSON.stringify(plan),plan.works.length,count,bytes,createdWorks,createdPieces]);
    let ordinal=0;
    for(const work of plan.works)for(const piece of work.pieces){
     const batchId=randomUUID(),batchInput={source:plan.source,sourceCommitSha:plan.sourceCommitSha,toolVersion:plan.toolVersion,workId:work.workId,pieceId:piece.pieceId,contentVersion:piece.contentVersion,items:piece.items.map(({relativePath,...item})=>item)};
     await client.query("INSERT INTO ingestion_batches(id,idempotency_key,request_hash,source,source_commit_sha,tool_version,operator_user_id,work_id,piece_id,content_version,total_count,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,7,$11)",[batchId,"bulk:"+groupId+":"+ordinal,createHash("sha256").update(JSON.stringify(batchInput)).digest("hex"),plan.source,plan.sourceCommitSha,plan.toolVersion,actor,work.workId,piece.pieceId,piece.contentVersion,JSON.stringify({contractVersion:"api-contract-v2.9.0",importGroupId:groupId})]);
     for(const item of piece.items)await client.query("INSERT INTO ingestion_items(batch_id,client_file_id,asset_type,file_name,expected_size_bytes,expected_sha256,mime_type) VALUES($1,$2,$3,$4,$5,$6,$7)",[batchId,item.clientFileId,item.assetType,item.fileName,item.sizeBytes,item.sha256,item.mimeType]);
     await client.query("INSERT INTO content_import_entries(group_id,ordinal,batch_id) VALUES($1,$2,$3)",[groupId,ordinal++,batchId]);
    }
    await client.query("INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,request_id,metadata) VALUES('admin',$1,'bulk_content_import_created','content_import_group',$2,$3,$4)",[actor,groupId,requestId,JSON.stringify({workCount:plan.works.length,pieceCount:count,createdWorks,createdPieces,declaredBytes:bytes})]);await client.query("COMMIT");
   }
  }catch(error){await client.query("ROLLBACK");if((error as any).code==="23505")throw conflict("Catalog order, identifier or chapter version conflicts with an existing import");throw error;}finally{client.release();}
  return this.get(groupId);
 }
 async get(id:string){
  const group=(await this.pool.query("SELECT id,plan,work_count,piece_count,declared_bytes,created_work_count,created_piece_count,created_at FROM content_import_groups WHERE id=$1",[id])).rows[0];if(!group)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Content import group not found");
  const entries=(await this.pool.query(`SELECT e.ordinal,b.id AS "batchId",b.work_id AS "workId",b.piece_id AS "pieceId",p.title,b.content_version AS "contentVersion",b.status,b.total_count AS "totalFiles",(SELECT count(*)::int FROM ingestion_items i WHERE i.batch_id=b.id AND i.status IN ('uploaded','queued','processing','ready','failed')) AS "uploadedFiles",b.succeeded_count AS "readyFiles",b.failed_count AS "failedFiles",b.updated_at AS "updatedAt" FROM content_import_entries e JOIN ingestion_batches b ON b.id=e.batch_id JOIN pieces p ON p.id=b.piece_id WHERE e.group_id=$1 ORDER BY e.ordinal`,[id])).rows;
  const counts:Record<string,number>={};for(const entry of entries)counts[entry.status]=(counts[entry.status]??0)+1;
  const status=counts.cancelled===entries.length?"cancelled":counts.published===entries.length?"published":counts.cancelled?"partially_cancelled":counts.partial_failed?"partial_failed":(counts.ready_for_review??0)+(counts.published??0)===entries.length?"ready_for_review":counts.processing||counts.queued?"processing":"uploading";
  return{groupId:group.id,plan:group.plan,status,workCount:group.work_count,pieceCount:group.piece_count,declaredBytes:String(group.declared_bytes),createdWorkCount:group.created_work_count,createdPieceCount:group.created_piece_count,createdAt:group.created_at.toISOString(),entries:entries.map(entry=>({...entry,updatedAt:entry.updatedAt.toISOString()}))};
 }
 async list(){const groups=(await this.pool.query("SELECT id AS \"groupId\",work_count AS \"workCount\",piece_count AS \"pieceCount\",created_at AS \"createdAt\" FROM content_import_groups ORDER BY created_at DESC,id DESC LIMIT 20")).rows;return{limit:20,scope:"recent",items:groups.map(group=>({...group,createdAt:group.createdAt.toISOString()}))};}
}
