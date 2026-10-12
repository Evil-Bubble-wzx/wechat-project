import type {Pool,PoolClient} from "pg";
import {ApiError} from "../api/errors.ts";
import {decodeKey,decrypt,encrypt,sha256} from "../security/crypto.ts";

export type ProfileMutation={mutationId:string;baseRevision:string;campusId:string|null;grade:string|null;readingLevel:string|null;reason:string};
type Db=Pool|PoolClient;
type ProfileRow={user_id:string;student_code:string;user_status:string;campus_id:string|null;campus_name:string|null;campus_status:string|null;grade:string|null;reading_level:string|null;profile_source:string|null;source_verified_at:Date|null;effective_from:Date|null;revision:string};
export type StudentProfile={
  studentCode:string;revision:string;status:"verified"|"unverified"|"unassigned";
  campusId:string|null;campusName:string|null;campusActive:boolean|null;grade:string|null;readingLevel:string|null;
  source:"admin"|"school_sync"|"unverified"|"user";verifiedAt:string|null;effectiveFrom:string|null;
};
function view(row:ProfileRow):StudentProfile{
  const source=(row.profile_source??"unverified") as StudentProfile["source"];
  return{studentCode:row.student_code,revision:row.revision,status:!row.campus_id?"unassigned":
    ["admin","school_sync"].includes(source)&&!!row.source_verified_at?"verified":"unverified",
    campusId:row.campus_id,campusName:row.campus_name,campusActive:row.campus_id?row.campus_status==="active":null,
    grade:row.grade,readingLevel:row.reading_level,source,verifiedAt:row.source_verified_at?.toISOString()??null,effectiveFrom:row.effective_from?.toISOString()??null};
}
const columns="SELECT u.id AS user_id,u.student_code,u.status AS user_status,p.campus_id,c.display_name AS campus_name,c.status AS campus_status,"+
  "p.grade,p.reading_level,p.profile_source,p.source_verified_at,COALESCE(p.revision,0)::text AS revision,v.effective_from "+
  "FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id LEFT JOIN campuses c ON c.id=p.campus_id "+
  "LEFT JOIN user_profile_versions v ON v.user_id=u.id AND v.effective_until IS NULL";

export class StudentProfileService{
  private readonly pool:Pool;
  private readonly key:Buffer;
  constructor(pool:Pool,keyBase64:string){this.pool=pool;this.key=decodeKey(keyBase64)}
  async assertManager(actorId:string,db:Db=this.pool):Promise<void>{
    const allowed=(await db.query("SELECT 1 FROM user_roles r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1 AND r.role='operations_admin' AND u.status='active'",[actorId])).rowCount;
    if(!allowed)throw new ApiError("FORBIDDEN",403,false,"Operations administrator role is required");
  }
  private async read(db:Db,userId:string):Promise<StudentProfile>{
    const row=(await db.query<ProfileRow>(columns+" WHERE u.id=$1",[userId])).rows[0];
    if(!row||row.user_status!=="active")throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Student account is unavailable");
    return view(row);
  }
  async me(userId:string){
    const profile=await this.read(this.pool,userId);
    const canManage=!!(await this.pool.query("SELECT 1 FROM user_roles WHERE user_id=$1 AND role='operations_admin'",[userId])).rowCount;
    return{profile,canManage};
  }
  async options(actorId:string){
    await this.assertManager(actorId);
    return{campuses:(await this.pool.query<{id:string;display_name:string}>("SELECT id,display_name FROM campuses WHERE status='active' ORDER BY id")).rows.map(r=>({value:r.id,label:r.display_name})),
      grades:[{value:"k",label:"Kindergarten"},...Array.from({length:9},(_,i)=>({value:String(i+1),label:"Grade "+(i+1)}))],
      readingLevels:Array.from({length:5},(_,i)=>({value:String(i+1),label:"Lv "+(i+1)+".x"})),
      cohortPolicy:"period_start" as const};
  }
  async get(actorId:string,studentCode:string){
    await this.assertManager(actorId);
    const target=(await this.pool.query<{id:string}>("SELECT id FROM users WHERE student_code=$1 AND status='active'",[studentCode])).rows[0];
    if(!target)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Student account is unavailable");
    return{profile:await this.read(this.pool,target.id)};
  }
  async update(actorId:string,studentCode:string,input:ProfileMutation,requestId:string){
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await this.assertManager(actorId,client);
      const target=(await client.query<{id:string}>("SELECT id FROM users WHERE student_code=$1 AND status='active'",[studentCode])).rows[0];
      if(!target)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Student account is unavailable");
      // Stable account order, shared with learning's account-level serialization.
      const accounts=(await client.query<{id:string;status:string}>("SELECT id,status FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE",[[actorId,target.id]])).rows;
      if(!accounts.some(r=>r.id===actorId&&r.status==="active"))throw new ApiError("FORBIDDEN",403,false,"Administrator is unavailable");
      if(!accounts.some(r=>r.id===target.id&&r.status==="active"))throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Student account is unavailable");
      if(!(await client.query("SELECT 1 FROM user_roles WHERE user_id=$1 AND role='operations_admin' FOR SHARE",[actorId])).rowCount)
        throw new ApiError("FORBIDDEN",403,false,"Operations administrator role is required");
      const scope="student-profile:"+actorId,hash=sha256(JSON.stringify({studentCode,...input}));
      const cached=(await client.query<{request_hash:string;response_ciphertext:Buffer;response_iv:Buffer;response_auth_tag:Buffer}>(
        "SELECT request_hash,response_ciphertext,response_iv,response_auth_tag FROM idempotency_records WHERE scope=$1 AND idempotency_key=$2",[scope,input.mutationId])).rows[0];
      if(cached){
        if(cached.request_hash.trim()!==hash)throw new ApiError("IDEMPOTENCY_KEY_REUSED",409,false,"Mutation ID was reused with another request");
        const response=JSON.parse(decrypt({ciphertext:cached.response_ciphertext,iv:cached.response_iv,authTag:cached.response_auth_tag},this.key).toString("utf8")) as {status:"applied"|"unchanged";profile:StudentProfile};
        await client.query("COMMIT");return response;
      }
      const before=await this.read(client,target.id);
      if(before.revision!==input.baseRevision)throw new ApiError("CONFLICT",409,false,"Profile changed; reload before editing");
      if(input.campusId){
        if(!(await client.query("SELECT id FROM campuses WHERE id=$1 AND status='active' FOR SHARE",[input.campusId])).rowCount)
          throw new ApiError("INVALID_REQUEST",400,false,"Campus is unavailable");
      }
      const unchanged=before.campusId===input.campusId&&before.grade===input.grade&&before.readingLevel===input.readingLevel&&before.source==="admin"&&!!before.verifiedAt;
      if(!unchanged){
        await client.query("SELECT set_config('app.request_id',$1,true),set_config('app.actor_id',$2,true)",[requestId,actorId]);
        await client.query("INSERT INTO user_profiles(user_id,campus_id,grade,reading_level,profile_source,source_verified_at) "+
          "VALUES($1,$2,$3,$4,'admin',clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET "+
          "campus_id=EXCLUDED.campus_id,grade=EXCLUDED.grade,reading_level=EXCLUDED.reading_level,profile_source='admin',source_verified_at=EXCLUDED.source_verified_at",
          [target.id,input.campusId,input.grade,input.readingLevel]);
        const after=await this.read(client,target.id);
        await client.query("INSERT INTO audit_events(actor_type,actor_id,action,target_type,target_id,request_id,before_state,after_state,metadata) "+
          "VALUES('admin',$1,'student_profile_maintained','user_profile',$2,$3,$4,$5,$6)",
          [actorId,target.id,requestId,JSON.stringify(before),JSON.stringify(after),JSON.stringify({reason:input.reason,mutationId:input.mutationId})]);
      }
      const response={status:unchanged?"unchanged" as const:"applied" as const,profile:await this.read(client,target.id)};
      const stored=encrypt(JSON.stringify(response),this.key);
      await client.query("INSERT INTO idempotency_records(scope,idempotency_key,request_hash,response_status,response_ciphertext,response_iv,response_auth_tag,expires_at) "+
        "VALUES($1,$2,$3,200,$4,$5,$6,clock_timestamp()+interval '30 days')",
        [scope,input.mutationId,hash,stored.ciphertext,stored.iv,stored.authTag]);
      await client.query("COMMIT");return response;
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  }
}
