import {createHash,timingSafeEqual} from "node:crypto";
import {AbortMultipartUploadCommand,ListPartsCommand,type S3Client} from "@aws-sdk/client-s3";
import type {Queue} from "bullmq";
import type {Pool,PoolClient} from "pg";
import {ApiError} from "../api/errors.ts";
import {decodeKey,hmacSha256} from "../security/crypto.ts";
import {ingestionQueueId} from "./dispatch.ts";
import type {IngestionJobPayload} from "./service.ts";

const statuses=["draft","uploading","queued","processing","partial_failed","ready_for_review","cancelled","published"];
export type BatchListOptions={status?:string;workId?:string;pieceId?:string;limit:number;cursor?:string};
export function parseBatchList(query:Record<string,unknown>):BatchListOptions {
  if(Object.keys(query).some(key=>!["status","workId","pieceId","limit","cursor"].includes(key)))throw new ApiError("INVALID_REQUEST",400,false,"Unknown batch filter");
  const limit=query.limit===undefined?20:Number(query.limit);
  if(!Number.isInteger(limit)||limit<1||limit>100||query.limit!==undefined&&(typeof query.limit!=="string"||!/^\d+$/.test(query.limit)))throw new ApiError("INVALID_REQUEST",400,false,"Invalid page size");
  const result:BatchListOptions={limit};
  for(const name of ["status","workId","pieceId","cursor"] as const){const value=query[name];if(value!==undefined){if(typeof value!=="string"||!value.length||value.length>(name==="cursor"?2048:128))throw new ApiError("INVALID_REQUEST",400,false,"Invalid batch filter");result[name]=value;}}
  if(result.status&&!statuses.includes(result.status))throw new ApiError("INVALID_REQUEST",400,false,"Invalid batch status");return result;
}
type Cursor={version:1;actor:string;filter:string;time:string;id:string};
const requestHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict=(message:string)=>new ApiError("INGESTION_BATCH_CONFLICT",409,false,message);
export class IngestionOperationsService {
  private pool:Pool;private s3:S3Client;private queue:Queue<IngestionJobPayload>;private key:Buffer|null;
  constructor(pool:Pool,s3:S3Client,queue:Queue<IngestionJobPayload>,keyBase64?:string){this.pool=pool;this.s3=s3;this.queue=queue;this.key=keyBase64?decodeKey(keyBase64):null;}
  private async admin(client:PoolClient,actor:string):Promise<void>{
    const result=await client.query("SELECT r.role FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=$1 AND u.status='active' AND r.role IN ('content_admin','operations_admin') FOR SHARE OF u,r",[actor]);
    if(!result.rowCount)throw new ApiError("FORBIDDEN",403,false,"Active content administrator required");
  }
  private encode(value:Cursor):string {if(!this.key)throw new ApiError("DEPENDENCY_UNAVAILABLE",503,true,"Batch cursor signing is unavailable");const body=Buffer.from(JSON.stringify(value)).toString("base64url");return body+"."+hmacSha256(body,this.key);}
  private decode(value:string,actor:string,filter:string):Cursor {
    try{if(!this.key)throw Error();const parts=value.split(".");if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0]!)||!/^[a-f0-9]{64}$/.test(parts[1]!))throw Error();const expected=Buffer.from(hmacSha256(parts[0]!,this.key)),supplied=Buffer.from(parts[1]!);if(!timingSafeEqual(expected,supplied))throw Error();const cursor=JSON.parse(Buffer.from(parts[0]!,"base64url").toString()) as Cursor;if(cursor.version!==1||cursor.actor!==actor||cursor.filter!==filter||!Number.isFinite(Date.parse(cursor.time))||!/^[a-f0-9-]{36}$/i.test(cursor.id))throw Error();return cursor;}
    catch{throw new ApiError("INVALID_REQUEST",400,false,"Batch cursor does not match this account or filter");}
  }
  async list(actor:string,options:BatchListOptions){
    const filter=requestHash({status:options.status??null,workId:options.workId??null,pieceId:options.pieceId??null,limit:options.limit});const cursor=options.cursor?this.decode(options.cursor,actor,filter):null;
    const result=await this.pool.query(`SELECT id AS "batchId",work_id AS "workId",piece_id AS "pieceId",content_version AS "contentVersion",status,total_count AS "totalCount",succeeded_count AS "succeededCount",failed_count AS "failedCount",created_at AS "createdAt",updated_at AS "updatedAt",created_at::text AS cursor_time FROM ingestion_batches WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR work_id=$2) AND ($3::text IS NULL OR piece_id=$3) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`,[options.status??null,options.workId??null,options.pieceId??null,cursor?.time??null,cursor?.id??null,options.limit+1]);
    const rows=result.rows.slice(0,options.limit),last=rows.at(-1);return{items:rows.map(({cursor_time,createdAt,updatedAt,...row})=>({...row,createdAt:createdAt.toISOString(),updatedAt:updatedAt.toISOString()})),nextCursor:result.rows.length>options.limit&&last?this.encode({version:1,actor,filter,time:last.cursor_time,id:last.batchId}):null};
  }
  async job(id:string){
    const row=(await this.pool.query(`SELECT j.id AS "jobId",i.batch_id AS "batchId",i.client_file_id AS "clientFileId",i.asset_type AS "assetType",j.status,j.attempt_count AS "attemptCount",j.max_attempts AS "maxAttempts",j.dispatch_generation AS "dispatchGeneration",j.error_code AS "errorCode",b.status AS "batchStatus",j.next_retry_at AS "nextRetryAt",j.started_at AS "startedAt",j.finished_at AS "finishedAt" FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id JOIN ingestion_batches b ON b.id=i.batch_id WHERE j.id=$1`,[id])).rows[0];
    if(!row)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Processing job not found");return{...row,canRetry:["failed","dead_letter"].includes(row.status)&&row.attemptCount<row.maxAttempts&&["queued","processing","partial_failed"].includes(row.batchStatus),remainingAttempts:Math.max(0,row.maxAttempts-row.attemptCount)};
  }
  private async mutation(client:PoolClient,actor:string,key:string,action:"retry"|"cancel",target:string){
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["ingestion-admin:"+actor+":"+key]);
    const row=(await client.query<{target_id:string;action:string;request_hash:string;dispatch_generation:number|null}>("SELECT target_id,action,request_hash,dispatch_generation FROM ingestion_admin_mutations WHERE actor_user_id=$1 AND idempotency_key=$2",[actor,key])).rows[0];
    const hash=requestHash({action,target});if(row&&(row.action!==action||row.target_id!==target||row.request_hash.trim()!==hash))throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"Key was used for another operation");return{row,hash};
  }
  async retry(id:string,actor:string,key:string,requestId:string){
    const client=await this.pool.connect();let generation=0;
    try{
      await client.query("BEGIN");const locator=(await client.query<{batch_id:string}>("SELECT i.batch_id FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE j.id=$1",[id])).rows[0];if(!locator)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Job not found");
      await client.query("SELECT id FROM ingestion_batches WHERE id=$1 FOR UPDATE",[locator.batch_id]);await this.admin(client,actor);
      const previous=await this.mutation(client,actor,key,"retry",id);
      if(previous.row)generation=previous.row.dispatch_generation!;
      else{
        const row=(await client.query<{status:string;attempt_count:number;max_attempts:number;dispatch_generation:number;ingestion_item_id:string;batch_status:string}>("SELECT j.*,b.status AS batch_status FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id JOIN ingestion_batches b ON b.id=i.batch_id WHERE j.id=$1 FOR UPDATE OF i,j",[id])).rows[0]!;
        if(!["failed","dead_letter"].includes(row.status)||row.attempt_count>=row.max_attempts||!["queued","processing","partial_failed"].includes(row.batch_status))throw new ApiError("INGESTION_JOB_FAILED",409,false,"Job is not retryable; fix invalid content in a new version");
        generation=row.dispatch_generation+1;
        await client.query("UPDATE processing_jobs SET status='queued',dispatch_generation=$2,error_code=NULL,error_summary=NULL,next_retry_at=NULL,finished_at=NULL WHERE id=$1",[id,generation]);
        await client.query("UPDATE ingestion_items SET status='queued',error_code=NULL,error_summary=NULL WHERE id=$1",[row.ingestion_item_id]);
        await client.query("UPDATE ingestion_batches SET status=CASE WHEN EXISTS(SELECT 1 FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=$1 AND j.status='running') THEN 'processing' ELSE 'queued' END,failed_count=(SELECT count(*) FROM ingestion_items WHERE batch_id=$1 AND status='failed') WHERE id=$1",[locator.batch_id]);
        await client.query("INSERT INTO ingestion_admin_mutations(actor_user_id,idempotency_key,action,target_id,request_hash,dispatch_generation) VALUES($1,$2,'retry',$3,$4,$5)",[actor,key,id,previous.hash,generation]);
        await client.query("INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,request_id,metadata) VALUES('admin',$1,'ingestion_retry_requested','processing_job',$2,$3,$4)",[actor,id,requestId,JSON.stringify({dispatchGeneration:generation,attemptCount:row.attempt_count})]);
      }
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    const row=(await this.pool.query<{status:string;attempt_count:number;max_attempts:number;dispatch_generation:number;batch_status:string}>("SELECT j.*,b.status AS batch_status FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id JOIN ingestion_batches b ON b.id=i.batch_id WHERE j.id=$1",[id])).rows[0]!;
    if(row.dispatch_generation===generation&&row.status==="queued"&&row.batch_status!=="cancelled"){
      try{await this.queue.add("content.ingestion.item",{type:"content.ingestion.item",processingJobId:id,requestId,dispatchGeneration:generation},{jobId:ingestionQueueId(id,generation),attempts:row.max_attempts-row.attempt_count,backoff:{type:"exponential",delay:1000},removeOnComplete:1000,removeOnFail:5000});}
      catch{throw new ApiError("DEPENDENCY_UNAVAILABLE",503,true,"Retry intent saved; repeat the same request to dispatch");}
    }
    return{status:"accepted" as const,resourceId:id};
  }
  async cancel(id:string,actor:string,key:string,requestId:string){
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");const batch=(await client.query<{status:string}>("SELECT status FROM ingestion_batches WHERE id=$1 FOR UPDATE",[id])).rows[0];if(!batch)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Batch not found");await this.admin(client,actor);
      const previous=await this.mutation(client,actor,key,"cancel",id);
      if(!previous.row){
        if(batch.status!=="cancelled"&&(!["draft","uploading","queued","partial_failed"].includes(batch.status)||(await client.query("SELECT j.id FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=$1 AND j.status='running'",[id])).rowCount))throw conflict("A running or finished batch cannot be cancelled");
        await client.query("UPDATE ingestion_batches SET status='cancelled',cancelled_at=COALESCE(cancelled_at,now()),failed_count=0 WHERE id=$1",[id]);
        await client.query("UPDATE ingestion_items SET status='cancelled',error_code=NULL,error_summary=NULL WHERE batch_id=$1 AND status NOT IN ('ready','cancelled')",[id]);
        await client.query("UPDATE processing_jobs SET status='cancelled',finished_at=now() WHERE ingestion_item_id IN(SELECT id FROM ingestion_items WHERE batch_id=$1) AND status NOT IN ('succeeded','cancelled')",[id]);
        await client.query("UPDATE upload_sessions SET status='aborted' WHERE ingestion_item_id IN(SELECT id FROM ingestion_items WHERE batch_id=$1) AND status IN ('active','expired')",[id]);
        await client.query("INSERT INTO ingestion_admin_mutations(actor_user_id,idempotency_key,action,target_id,request_hash) VALUES($1,$2,'cancel',$3,$4)",[actor,key,id,previous.hash]);
        await client.query("INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,request_id,metadata) VALUES('admin',$1,'ingestion_cancel_requested','ingestion_batch',$2,$3,'{\"completedFilesRetained\":true}')",[actor,id,requestId]);
      }
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    const uploads=await this.pool.query<{id:string;bucket:string;object_key:string;multipart_upload_id:string}>("SELECT u.id,u.bucket,u.object_key,u.multipart_upload_id FROM upload_sessions u JOIN ingestion_items i ON i.id=u.ingestion_item_id WHERE i.batch_id=$1 AND u.status='aborted' AND u.abort_confirmed_at IS NULL",[id]);
    for(const upload of uploads.rows){
      const input={Bucket:upload.bucket,Key:upload.object_key,UploadId:upload.multipart_upload_id};
      try{
        try{await this.s3.send(new AbortMultipartUploadCommand(input));}catch(error){if((error as {name?:string}).name!=="NoSuchUpload")throw error;}
        try{const remaining=await this.s3.send(new ListPartsCommand({...input,MaxParts:1}));if(remaining.Parts?.length||remaining.IsTruncated)throw Error("Parts remain");}catch(error){if((error as {name?:string}).name!=="NoSuchUpload")throw error;}
        await this.pool.query("UPDATE upload_sessions SET abort_confirmed_at=now() WHERE id=$1 AND status='aborted'",[upload.id]);
      }catch{throw new ApiError("DEPENDENCY_UNAVAILABLE",503,true,"Batch cancelled; repeat this request to finish multipart cleanup");}
    }
    return{status:"cancelled" as const,resourceId:id};
  }
}
