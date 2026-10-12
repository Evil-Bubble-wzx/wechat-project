import {createHash} from "node:crypto";
import {CompleteMultipartUploadCommand,HeadObjectCommand,ListPartsCommand,UploadPartCommand,type S3Client} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import type {Pool,PoolClient} from "pg";
import {ApiError} from "../api/errors.ts";

export type UploadedPart={partNumber:number;etag:string;sizeBytes:number};
type PartInput={partNumber:number;etag:string};
type Upload={id:string;ingestion_item_id:string;batch_id:string;batch_status:string;item_status:string;bucket:string;object_key:string;multipart_upload_id:string;part_size_bytes:number;part_count:number;expected_size_bytes:string;expected_sha256:string;expires_at:Date;status:string;storage_nonce:string|null;completion_request_hash:string|null;completion_parts:PartInput[]|null};
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict=(message:string)=>new ApiError("INGESTION_BATCH_CONFLICT",409,false,message);
export function canonicalParts(parts:PartInput[]):PartInput[]{
  const result=[...parts].sort((a,b)=>a.partNumber-b.partNumber);
  if(!result.length||result.length>10000||result.some((part,index)=>part.partNumber!==index+1||typeof part.etag!=="string"||!part.etag.length||part.etag.length>256))throw new ApiError("INVALID_REQUEST",400,false,"Parts must be unique and consecutive from 1");
  return result.map(({partNumber,etag})=>({partNumber,etag}));
}
export function validateStorageParts(upload:{part_size_bytes:number;part_count:number;expected_size_bytes:string},parts:UploadedPart[]):void{
  if(parts.length!==upload.part_count||parts.some((part,index)=>part.partNumber!==index+1||part.sizeBytes!==Math.min(upload.part_size_bytes,Number(upload.expected_size_bytes)-index*upload.part_size_bytes)))throw new ApiError("INVALID_REQUEST",400,false,"Stored part sizes or numbers differ from declaration");
}
export class UploadRecoveryService{
  private pool:Pool;
  private s3:S3Client;
  constructor(pool:Pool,s3:S3Client){this.pool=pool;this.s3=s3;}
  private async lock(client:PoolClient,id:string,actor?:string):Promise<Upload>{
    const locator=(await client.query<{batch_id:string}>(`SELECT i.batch_id FROM upload_sessions u JOIN ingestion_items i ON i.id=u.ingestion_item_id WHERE u.id=$1`,[id])).rows[0];
    if(!locator)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Upload session not found");
    // All upload mutations share batch -> item -> session ordering.
    await client.query("SELECT id FROM ingestion_batches WHERE id=$1 FOR UPDATE",[locator.batch_id]);
    const row=(await client.query<Upload>(`SELECT u.*,i.batch_id,i.status AS item_status,b.status AS batch_status FROM upload_sessions u JOIN ingestion_items i ON i.id=u.ingestion_item_id JOIN ingestion_batches b ON b.id=i.batch_id WHERE u.id=$1 FOR UPDATE OF i,u`,[id])).rows[0]!;
    if(actor){
      const role=await client.query(`SELECT r.role FROM users a JOIN user_roles r ON r.user_id=a.id WHERE a.id=$1 AND a.status='active' AND r.role IN ('content_admin','operations_admin') FOR SHARE OF a,r`,[actor]);
      if(!role.rowCount)throw new ApiError("FORBIDDEN",403,false,"Active content administrator required");
    }
    return row;
  }
  private accepts(upload:Upload){if(!["draft","uploading"].includes(upload.batch_status)||upload.item_status!=="uploading"||upload.status!=="active")throw conflict("Upload no longer accepts changes");}
  private async parts(upload:Upload):Promise<UploadedPart[]>{
    const parts:UploadedPart[]=[];let marker:string|undefined;
    do{
      const page=await this.s3.send(new ListPartsCommand({Bucket:upload.bucket,Key:upload.object_key,UploadId:upload.multipart_upload_id,PartNumberMarker:marker,MaxParts:1000}));
      for(const part of page.Parts??[]){if(!part.PartNumber||!part.ETag||part.Size===undefined)throw new Error("Invalid object-storage part response");parts.push({partNumber:part.PartNumber,etag:part.ETag,sizeBytes:part.Size});}
      const next=page.IsTruncated?page.NextPartNumberMarker:undefined;
      if(page.IsTruncated&&(!next||Number(next)<=Number(marker??0)))throw new Error("Object-storage pagination did not advance");marker=next;
      if(parts.length>10000)throw new Error("Object-storage parts exceeded limit");
    }while(marker!==undefined);
    return parts.sort((a,b)=>a.partNumber-b.partNumber);
  }
  private async mutation(client:PoolClient,actor:string,key:string,id:string,action:string,hash:string,expiry?:Date):Promise<Date|undefined>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["upload-mutation:"+actor+":"+key]);
    const previous=(await client.query<{upload_session_id:string;action:string;request_hash:string;lease_expires_at:Date|null}>("SELECT * FROM upload_session_mutations WHERE actor_user_id=$1 AND idempotency_key=$2",[actor,key])).rows[0];
    if(previous){if(previous.upload_session_id!==id||previous.action!==action||previous.request_hash.trim()!==hash)throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"Upload mutation key was used with another request");return previous.lease_expires_at??undefined;}
    await client.query("INSERT INTO upload_session_mutations(actor_user_id,idempotency_key,upload_session_id,action,request_hash,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6)",[actor,key,id,action,hash,expiry??null]);return expiry;
  }
  async status(id:string,actor:string){
    const client=await this.pool.connect();try{
      await client.query("BEGIN");const upload=await this.lock(client,id,actor);
      const parts=upload.status==="completed"?[]:upload.completion_parts?.map(part=>({...part,sizeBytes:Math.min(upload.part_size_bytes,Number(upload.expected_size_bytes)-(part.partNumber-1)*upload.part_size_bytes)}))??(upload.status==="active"&&["draft","uploading"].includes(upload.batch_status)?await this.parts(upload):[]);
      await client.query("COMMIT");return{uploadSessionId:id,status:upload.status==="active"?(upload.completion_parts?"completing":upload.expires_at<=new Date()?"expired":"active"):upload.status,partSizeBytes:upload.part_size_bytes,partCount:upload.part_count,expiresAt:upload.expires_at.toISOString(),uploadedParts:parts};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async renew(id:string,actor:string,key:string){
    const client=await this.pool.connect();try{
      await client.query("BEGIN");const upload=await this.lock(client,id,actor);this.accepts(upload);
      if(upload.completion_parts)throw conflict("Completion has started; retry the recorded completion instead");
      const storedParts=await this.parts(upload);
      const parts=storedParts.filter(part=>part.partNumber>=1&&part.partNumber<=upload.part_count&&part.sizeBytes===Math.min(upload.part_size_bytes,Number(upload.expected_size_bytes)-(part.partNumber-1)*upload.part_size_bytes));
      const expiry=(await this.mutation(client,actor,key,id,"renew",digest({id}),new Date(Date.now()+900000)))!;
      if(expiry<=new Date())throw new ApiError("UPLOAD_SESSION_EXPIRED",410,false,"Renewal key lease expired; request a new renewal key");
      await client.query("UPDATE upload_sessions SET expires_at=GREATEST(expires_at,$2) WHERE id=$1",[id,expiry]);
      const signed=[];const stored=new Set(parts.map(part=>part.partNumber));
      for(let partNumber=1;partNumber<=upload.part_count;partNumber++)if(!stored.has(partNumber))signed.push({partNumber,uploadUrl:await getSignedUrl(this.s3,new UploadPartCommand({Bucket:upload.bucket,Key:upload.object_key,UploadId:upload.multipart_upload_id,PartNumber:partNumber}),{expiresIn:Math.max(1,Math.floor((expiry.getTime()-Date.now())/1000))})});
      await client.query("COMMIT");return{uploadSessionId:id,partSizeBytes:upload.part_size_bytes,expiresAt:expiry.toISOString(),uploadedParts:parts,parts:signed};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async complete(id:string,input:PartInput[],actor?:string,key?:string){
    const parts=canonicalParts(input),hash=digest(parts);const client=await this.pool.connect();
    try{
      await client.query("BEGIN");let upload=await this.lock(client,id,actor);
      if(upload.completion_request_hash&&upload.completion_request_hash.trim()!==hash)throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"Completion parts cannot be changed after confirmation started");
      if(upload.status==="completed"){if(actor&&key)await this.mutation(client,actor,key,id,"complete",hash);await client.query("COMMIT");return{status:"completed" as const,resourceId:id};}
      this.accepts(upload);
      if(!upload.completion_parts){
        if(upload.expires_at<=new Date())throw new ApiError("UPLOAD_SESSION_EXPIRED",410,false,"Renew the upload lease before completing");
        const stored=await this.parts(upload);validateStorageParts(upload,stored);
        if(parts.length!==stored.length||parts.some((part,index)=>part.etag!==stored[index]!.etag))throw new ApiError("INVALID_REQUEST",400,false,"Completion ETags do not match object storage");
        await client.query("UPDATE upload_sessions SET completion_request_hash=$2,completion_parts=$3,completion_intent_at=now() WHERE id=$1",[id,hash,JSON.stringify(parts)]);
      }
      if(actor&&key)await this.mutation(client,actor,key,id,"complete",hash);
      // Commit the immutable intent BEFORE the external completion side effect.
      await client.query("COMMIT");await client.query("BEGIN");upload=await this.lock(client,id,actor);
      if(upload.status==="completed"){await client.query("COMMIT");return{status:"completed" as const,resourceId:id};}
      this.accepts(upload);
      try{await this.s3.send(new CompleteMultipartUploadCommand({Bucket:upload.bucket,Key:upload.object_key,UploadId:upload.multipart_upload_id,MultipartUpload:{Parts:parts.map(part=>({PartNumber:part.partNumber,ETag:part.etag}))}}));}
      catch(error){if((error as {name?:string}).name!=="NoSuchUpload"||!upload.storage_nonce)throw error;}
      const head=await this.s3.send(new HeadObjectCommand({Bucket:upload.bucket,Key:upload.object_key}));
      if(head.ContentLength!==Number(upload.expected_size_bytes)||(upload.storage_nonce&&(head.Metadata?.["upload-session-id"]!==upload.storage_nonce||head.Metadata?.["ingestion-item-id"]!==upload.ingestion_item_id||head.Metadata?.["expected-sha256"]!==upload.expected_sha256.trim())))throw new ApiError("ASSET_CHECKSUM_MISMATCH",422,false,"Completed object identity or size differs from declaration");
      await client.query("UPDATE upload_sessions SET status='completed',completed_at=now() WHERE id=$1",[id]);
      await client.query("UPDATE ingestion_items SET status='uploaded' WHERE id=$1",[upload.ingestion_item_id]);
      await client.query("COMMIT");return{status:"completed" as const,resourceId:id};
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
}
