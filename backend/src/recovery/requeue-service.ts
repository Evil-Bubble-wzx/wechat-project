import type {Pool} from "pg";
import type {IngestionJobPayload} from "../ingestion/service.ts";
import {ingestionQueueId} from "../ingestion/dispatch.ts";
export interface RecoveryQueuePort {
  getJob(jobId:string):Promise<unknown|null>;
  add(name:string,payload:IngestionJobPayload,options:Record<string,unknown>):Promise<unknown>;
}
export class RequeueService {
  private pool:Pool;private queue:RecoveryQueuePort;
  constructor(pool:Pool,queue:RecoveryQueuePort){this.pool=pool;this.queue=queue;}
  async rebuild(requestId:string,staleAfterMinutes=10){
    if(!Number.isInteger(staleAfterMinutes)||staleAfterMinutes<1||staleAfterMinutes>1440)throw Error("staleAfterMinutes must be between 1 and 1440");
    const candidates=await this.pool.query<{id:string;batch_id:string;dispatch_generation:number;status:string}>("SELECT job.id,item.batch_id,job.dispatch_generation,job.status FROM processing_jobs job JOIN ingestion_items item ON item.id=job.ingestion_item_id JOIN ingestion_batches batch ON batch.id=item.batch_id WHERE (job.status='queued' OR (job.status='retry_wait' AND (job.next_retry_at IS NULL OR job.next_retry_at<=now())) OR (job.status='running' AND job.updated_at<now()-make_interval(mins=>$1))) AND item.status<>'cancelled' AND batch.status IN ('queued','processing','partial_failed') ORDER BY job.created_at",[staleAfterMinutes]);
    let enqueued=0,alreadyPresent=0,exhausted=0;
    for(const candidate of candidates.rows){
      const id=candidate.id,existing=await this.queue.getJob(ingestionQueueId(id,candidate.dispatch_generation)) as {getState?:()=>Promise<string>}|null;
      const state=existing?(existing.getState?await existing.getState():"waiting"):null;
      if(existing&&candidate.status!=="running"&&!["failed","completed"].includes(state!)){alreadyPresent++;continue;}
      const client=await this.pool.connect();let locked=false,dispatch:{generation:number;attempts:number}|null=null;
      try{
        const lock=(await client.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked",["ingestion-job:"+id])).rows[0];
        locked=lock?.locked??false;if(!locked){alreadyPresent++;continue;}
        await client.query("BEGIN");
        const batch=(await client.query<{status:string}>("SELECT status FROM ingestion_batches WHERE id=$1 FOR UPDATE",[candidate.batch_id])).rows[0];
        const job=(await client.query<{status:string;dispatch_generation:number;attempt_count:number;max_attempts:number;ingestion_item_id:string}>("SELECT status,dispatch_generation,attempt_count,max_attempts,ingestion_item_id FROM processing_jobs WHERE id=$1 FOR UPDATE",[id])).rows[0];
        if(!batch||!job||!["queued","processing","partial_failed"].includes(batch.status)||!["queued","retry_wait","running"].includes(job.status)||job.dispatch_generation!==candidate.dispatch_generation){await client.query("COMMIT");alreadyPresent++;continue;}
        if(job.attempt_count>=job.max_attempts){
          await client.query("UPDATE processing_jobs SET status='dead_letter',error_code='INGESTION_JOB_FAILED',error_summary='Cumulative attempt limit reached during recovery',finished_at=now(),next_retry_at=NULL WHERE id=$1",[id]);
          await client.query("UPDATE ingestion_items SET status='failed',error_code='INGESTION_JOB_FAILED',error_summary='Cumulative attempt limit reached during recovery' WHERE id=$1",[job.ingestion_item_id]);
          await client.query("UPDATE ingestion_batches SET failed_count=(SELECT count(*) FROM ingestion_items WHERE batch_id=$1 AND status='failed'),status=CASE WHEN EXISTS(SELECT 1 FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=$1 AND j.status='running') THEN 'processing' ELSE 'partial_failed' END WHERE id=$1",[candidate.batch_id]);
          await client.query("COMMIT");exhausted++;continue;
        }
        const generation=job.dispatch_generation+(job.status==="running"||existing?1:0);
        await client.query("UPDATE processing_jobs SET status='queued',dispatch_generation=$2,worker_id=NULL,next_retry_at=NULL WHERE id=$1",[id,generation]);
        await client.query("UPDATE ingestion_items SET status='queued',error_code=NULL,error_summary=NULL WHERE id=$1",[job.ingestion_item_id]);
        await client.query("UPDATE ingestion_batches SET status=CASE WHEN EXISTS(SELECT 1 FROM processing_jobs j JOIN ingestion_items i ON i.id=j.ingestion_item_id WHERE i.batch_id=$1 AND j.status='running') THEN 'processing' ELSE 'queued' END WHERE id=$1",[candidate.batch_id]);
        await client.query("COMMIT");dispatch={generation,attempts:job.max_attempts-job.attempt_count};
      }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
      finally{if(locked)await client.query("SELECT pg_advisory_unlock(hashtext($1))",["ingestion-job:"+id]);client.release();}
      if(dispatch){await this.queue.add("content.ingestion.item",{type:"content.ingestion.item",processingJobId:id,requestId,dispatchGeneration:dispatch.generation},{jobId:ingestionQueueId(id,dispatch.generation),attempts:dispatch.attempts,backoff:{type:"exponential",delay:1000},removeOnComplete:1000,removeOnFail:5000});enqueued++;}
    }
    return{candidates:candidates.rows.length,enqueued,alreadyPresent,exhausted};
  }
}
