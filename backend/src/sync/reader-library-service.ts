import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { ApiError } from "../api/errors.ts";

export type LibraryOperation={
  operationId:string;workId:string;action:"favorite"|"unfavorite"|"open";baseRevision:string;occurredAt:string;
};
export type LibrarySyncInput={schemaVersion:1;batchId:string;cursor:string|null;operations:LibraryOperation[];limit:number};
export type LibraryEntry={workId:string;favorite:boolean;favoriteRevision:string;lastOpenedAt:string|null;serverUpdatedAt:string};
export type LibraryOperationResult={operationId:string;status:"applied"|"unchanged"|"rejected";reason:string|null;clockStatus:"ok"|"future_skew";entry:LibraryEntry|null};
export type LibrarySyncResponse={schemaVersion:1;batchId:string;serverTime:string;operations:LibraryOperationResult[];changes:LibraryEntry[];nextCursor:string;hasMore:boolean};
type Row={work_id:string;favorite:boolean;favorite_revision:string;last_opened_at:Date|null;server_updated_at:Date;change_seq:string};
const columns="work_id,favorite,favorite_revision::text,last_opened_at,server_updated_at,change_seq::text";
function canonical(value:unknown):string{
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  if(value&&typeof value==="object")return "{"+Object.keys(value as Record<string,unknown>).sort().map(key=>JSON.stringify(key)+":"+canonical((value as Record<string,unknown>)[key])).join(",")+"}";
  return JSON.stringify(value);
}
const hash=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
export function libraryOperationIdFor(operation:Omit<LibraryOperation,"operationId">){return "library-op-v1:"+hash(operation)}
function view(row:Row):LibraryEntry{return {workId:row.work_id,favorite:row.favorite,favoriteRevision:row.favorite_revision,lastOpenedAt:row.last_opened_at?.toISOString()??null,serverUpdatedAt:row.server_updated_at.toISOString()}}

export class ReaderLibraryService{
  private readonly pool:Pool;
  private readonly key:Buffer;
  constructor(pool:Pool,keyBase64:string){this.pool=pool;this.key=Buffer.from(keyBase64,"base64");if(this.key.length<32)throw new Error("Library cursor key must be at least 32 bytes")}
  private cursor(userId:string,sequence:string){
    const payload=Buffer.from(JSON.stringify({userId,sequence})).toString("base64url");
    return payload+"."+createHmac("sha256",this.key).update(payload).digest("base64url");
  }
  private readCursor(userId:string,cursor:string|null):string{
    if(cursor===null)return "0";
    try{
      const [payload,signature,extra]=cursor.split(".");
      const expected=createHmac("sha256",this.key).update(payload!).digest("base64url");
      if(extra||!signature||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new Error("signature");
      const decoded=JSON.parse(Buffer.from(payload!,"base64url").toString()) as {userId:string;sequence:string};
      if(decoded.userId!==userId||!/^(0|[1-9][0-9]{0,18})$/.test(decoded.sequence))throw new Error("scope");
      return decoded.sequence;
    }catch{throw new ApiError("INVALID_REQUEST",400,false,"Library cursor is invalid")}
  }
  async sync(userId:string,input:LibrarySyncInput):Promise<LibrarySyncResponse>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      // Serialize both changes and cursor reads for this user, including across devices.
      await client.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",[userId]);
      const requestHash=hash(input);
      const cached=(await client.query<{request_hash:string;response:LibrarySyncResponse}>("SELECT request_hash,response FROM reader_library_batches WHERE user_id=$1 AND batch_id=$2",[userId,input.batchId])).rows[0];
      if(cached){
        if(cached.request_hash.trim()!==requestHash)throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"Library batch ID reused with another request");
        await client.query("COMMIT");return cached.response;
      }
      const sequence=this.readCursor(userId,input.cursor);
      const serverTime=(await client.query<{at:Date}>("SELECT statement_timestamp() AS at")).rows[0]!.at;
      const results:LibraryOperationResult[]=[];
      for(const operation of input.operations){
        const {operationId,...payload}=operation,operationHash=hash(payload);
        const replay=(await client.query<{request_hash:string;response:LibraryOperationResult}>("SELECT request_hash,response FROM reader_library_operations WHERE user_id=$1 AND operation_id=$2",[userId,operationId])).rows[0];
        if(replay){
          if(replay.request_hash.trim()!==operationHash)throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"Library operation ID reused");
          results.push(replay.response);continue;
        }
        if(libraryOperationIdFor(payload)!==operationId)throw new ApiError("INVALID_REQUEST",400,false,"Library operation does not match its ID");
        const current=(await client.query<Row>(`SELECT ${columns} FROM reader_library_entries WHERE user_id=$1 AND work_id=$2`,[userId,operation.workId])).rows[0];
        const available=(await client.query<{exists:boolean}>("SELECT EXISTS(SELECT 1 FROM works WHERE id=$1 AND status='published') AS exists",[operation.workId])).rows[0]!.exists;
        const future=new Date(operation.occurredAt)>serverTime;
        let reason:string|null=null,status:LibraryOperationResult["status"]="unchanged",entry=current?view(current):null;
        if(!available&&operation.action!=="unfavorite"){status="rejected";reason="work_unavailable"}
        else if(!available&&!current){status="rejected";reason="work_unavailable"}
        else if(operation.action!=="open"&&BigInt(operation.baseRevision)>BigInt(current?.favorite_revision??"0")){status="rejected";reason="future_revision"}
        else if(operation.action==="favorite"&&current&&!current.favorite&&BigInt(operation.baseRevision)<BigInt(current.favorite_revision)){reason="stale_favorite_blocked_by_delete"}
        else{
          const favorite=operation.action==="open"?(current?.favorite??false):operation.action==="favorite";
          // Every new explicit unfavorite establishes a tombstone, including
          // rows that only have an open observation (favorite revision 0).
          const revision=BigInt(current?.favorite_revision??"0")+(operation.action!=="open"&&(!current||favorite!==current.favorite||operation.action==="unfavorite")?1n:0n);
          const occurred=new Date(Math.min(Date.parse(operation.occurredAt),serverTime.getTime()));
          const lastOpened=operation.action==="open"?new Date(Math.max(current?.last_opened_at?.getTime()??0,occurred.getTime())):(current?.last_opened_at??null);
          if(!current||favorite!==current.favorite||revision!==BigInt(current.favorite_revision)||lastOpened?.getTime()!==current.last_opened_at?.getTime()){
            const stored=(await client.query<Row>(`INSERT INTO reader_library_entries(user_id,work_id,favorite,favorite_revision,last_opened_at,server_updated_at)
              VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,work_id) DO UPDATE SET
              favorite=EXCLUDED.favorite,favorite_revision=EXCLUDED.favorite_revision,last_opened_at=EXCLUDED.last_opened_at,
              server_updated_at=EXCLUDED.server_updated_at,change_seq=nextval('reader_library_change_seq') RETURNING ${columns}`,
              [userId,operation.workId,favorite,revision.toString(),lastOpened,serverTime])).rows[0]!;
            entry=view(stored);status="applied";
          }
        }
        const result:LibraryOperationResult={operationId,status,reason,clockStatus:future?"future_skew":"ok",entry};
        await client.query("INSERT INTO reader_library_operations(user_id,operation_id,request_hash,response) VALUES($1,$2,$3,$4)",[userId,operationId,operationHash,JSON.stringify(result)]);
        results.push(result);
      }
      const rows=(await client.query<Row>(`SELECT ${columns} FROM reader_library_entries WHERE user_id=$1 AND change_seq>$2 ORDER BY reader_library_entries.change_seq LIMIT $3`,[userId,sequence,input.limit+1])).rows;
      const page=rows.slice(0,input.limit);
      const response:LibrarySyncResponse={schemaVersion:1,batchId:input.batchId,serverTime:serverTime.toISOString(),operations:results,changes:page.map(view),nextCursor:this.cursor(userId,page.at(-1)?.change_seq??sequence),hasMore:rows.length>input.limit};
      await client.query("INSERT INTO reader_library_batches(user_id,batch_id,request_hash,response) VALUES($1,$2,$3,$4)",[userId,input.batchId,requestHash,JSON.stringify(response)]);
      await client.query("COMMIT");return response;
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  }
}
