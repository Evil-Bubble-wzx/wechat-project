import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import {Ajv2020} from "ajv/dist/2020.js";
import pg from "pg";
import {loadConfig} from "../src/config.ts";
import {migrateUp,rollbackOne} from "../src/database/migrator.ts";
import {createApp} from "../src/api/app.ts";
import {ApiError} from "../src/api/errors.ts";
import type {SessionServicePort} from "../src/api/session-routes.ts";
import {ReaderLibraryService,libraryOperationIdFor,type LibrarySyncInput} from "../src/sync/reader-library-service.ts";
const schema="library_test_"+randomBytes(8).toString("hex");
if(!/^library_test_[a-f0-9]{16}$/.test(schema))throw new Error("Invalid test schema");
const config=loadConfig(),{Pool}=pg,admin=new Pool({connectionString:config.databaseUrl,max:1});
const pool=new Pool({connectionString:config.databaseUrl,max:4,options:`-c search_path=${schema},public`});
const userId=randomUUID(),otherId=randomUUID();
let address="",sequence=0;
const require=createRequire(import.meta.url),addFormats=require("ajv-formats");
const schemaDocument=JSON.parse(await readFile(new URL("../contracts/schemas/api-v1.schema.json",import.meta.url),"utf8"));
const ajv=new Ajv2020({allErrors:true,strict:true});addFormats(ajv);ajv.addSchema(schemaDocument);
const validateRequest=ajv.getSchema(schemaDocument.$id+"#/$defs/LibrarySyncRequest")!;
const validateResponse=ajv.getSchema(schemaDocument.$id+"#/$defs/LibrarySyncResponse")!;
function batch(action?:"favorite"|"unfavorite"|"open",revision="0",workId="book-one",occurredAt=new Date().toISOString()):LibrarySyncInput{
  const payload={workId,action:action??"open",baseRevision:revision,occurredAt};
  return {schemaVersion:1,batchId:"library-smoke-"+(++sequence),cursor:null,operations:action?[{operationId:libraryOperationIdFor(payload),...payload}]:[],limit:100};
}
async function post(input:LibrarySyncInput,token=userId){
  assert.equal(validateRequest(input),true,ajv.errorsText(validateRequest.errors));
  const response=await fetch(address+"/api/v1/me/library/sync",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token,"idempotency-key":input.batchId},body:JSON.stringify(input)});
  const data=await response.json() as any;
  assert.equal(validateResponse(data),true,ajv.errorsText(validateResponse.errors));
  assert.equal(response.status,200,JSON.stringify(data));assert.match(data.requestId,/^[0-9a-f-]{36}$/);delete data.requestId;return data;
}
async function main(){
  await admin.query(`CREATE SCHEMA "${schema}"`);
  let app:ReturnType<typeof createApp>|undefined;
  try{
    await migrateUp(pool,{schema});
    await pool.query("INSERT INTO users(id) VALUES($1),($2)",[userId,otherId]);
    await pool.query("INSERT INTO works(id,title,status) VALUES('book-one','One','published'),('book-two','Two','published'),('draft-book','Draft','draft')");
    const sessions={async authenticateAccessToken(token:string){if(token!==userId&&token!==otherId)throw new ApiError("UNAUTHENTICATED",401,false,"Invalid token");return {userId:token,sessionId:randomUUID()}}} as SessionServicePort;
    app=createApp({sessionService:sessions,readerLibraryService:new ReaderLibraryService(pool,config.auth.identityHashKeyBase64)});
    address=await app.listen({host:"127.0.0.1",port:0});
    const unauthorized=await fetch(address+"/api/v1/me/library/sync",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    assert.equal(unauthorized.status,401);
    const require=createRequire(import.meta.url),{createLibrarySyncManager}=require("../../miniprogram/modules/sync/library-sync.js");
    function device(){
      const storage=new Map<string,unknown>();let state:Record<string,any>={};
      const host={accountScope:()=>userId,read:()=>state,mutate:(fn:(state:Record<string,any>)=>Record<string,any>)=>{state=fn(state);return state}};
      const manager=createLibrarySyncManager({runtime:{getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:unknown)=>storage.set(key,value)},host,
        api:{isAuthenticated:()=>true,currentUser:()=>({userId}),librarySyncAvailable:()=>true},submit:post});
      manager.activate(userId,{sync:false});return {manager,host};
    }
    const first=device(),second=device();
    first.manager.record("favorite","book-one",false);first.manager.record("open","book-one",false);
    assert.equal(await first.manager.trigger("send",false),true);
    assert.equal(await second.manager.trigger("pull",true),true);
    assert.deepEqual(second.host.read().favorites,["book-one"]);assert.deepEqual(second.host.read().recent,["book-one"]);
    // Create an offline save based on revision 1 before the other device deletes it.
    first.manager.record("favorite","book-one",false);
    second.manager.record("unfavorite","book-one",false);await second.manager.trigger("delete",false);
    await first.manager.trigger("late-save",false);
    assert.deepEqual(first.host.read().favorites,[]);assert.equal(first.manager.status().status,"attention");
    first.manager.record("favorite","book-one",false);await first.manager.trigger("explicit-restore",false);
    await second.manager.trigger("pull",true);assert.deepEqual(second.host.read().favorites,["book-one"]);
    const open=batch("open","0","book-two","2999-01-01T00:00:00.000Z"),original=await post(open);
    assert.equal(original.operations[0].clockStatus,"future_skew");
    assert.ok(Date.parse(original.operations[0].entry.lastOpenedAt)<=Date.parse(original.serverTime));
    assert.deepEqual(await post(open),original,"batch replay must not bump recent time");
    const differentBatch={...open,batchId:"library-smoke-operation-replay"};const replay=await post(differentBatch);
    assert.deepEqual(replay.operations,original.operations,"operation replay also retains time");
    const deletedOpened=await post(batch("unfavorite","0","book-two"));
    assert.equal(deletedOpened.operations[0].entry.favoriteRevision,"1","unfavorite after open-only creates a deletion tombstone");
    const staleOpened=await post(batch("favorite","0","book-two"));
    assert.equal(staleOpened.operations[0].reason,"stale_favorite_blocked_by_delete");assert.equal(staleOpened.operations[0].entry.favorite,false);
    const conflict=await fetch(address+"/api/v1/me/library/sync",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+userId,"idempotency-key":open.batchId},body:JSON.stringify({...open,limit:1})});
    assert.equal(conflict.status,409);assert.equal((await conflict.json() as any).error.code,"IDEMPOTENCY_KEY_REUSED");
    const other=await post(batch(),otherId);assert.deepEqual(other.changes,[]);
    const crossCursor=await fetch(address+"/api/v1/me/library/sync",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+otherId,"idempotency-key":"library-cross-cursor"},body:JSON.stringify({...batch(),batchId:"library-cross-cursor",cursor:original.nextCursor})});
    assert.equal(crossCursor.status,400);
    assert.equal((await post(batch("favorite","0","draft-book"))).operations[0].reason,"work_unavailable");
    const paged={...batch(),limit:1};const page1=await post(paged);assert.equal(page1.changes.length,1);assert.equal(page1.hasMore,true);
    const page2=await post({...batch(),cursor:page1.nextCursor,limit:1});assert.equal(page2.changes.length,1);assert.notEqual(page2.changes[0].workId,page1.changes[0].workId);
    // No new events are needed for later pulls to see another device's change.
    const newest=await post(batch("unfavorite","3"));await second.manager.trigger("foreground",true);assert.deepEqual(second.host.read().favorites,[]);
    assert.equal(newest.operations[0].status,"applied");
    assert.equal(await rollbackOne(pool,{schema}),"0016_historical_score_invalidation");
    assert.equal(await rollbackOne(pool,{schema}),"0015_ranking_quiz_analysis");
    assert.equal(await rollbackOne(pool,{schema}),"0014_quiz_history");
    assert.equal(await rollbackOne(pool,{schema}),"0013_content_catalog_projection");
    await assert.rejects(rollbackOne(pool,{schema}),/Cannot roll back reader library/);
    const points=(await pool.query("SELECT count(*)::integer AS count FROM learning_score_events")).rows[0].count;assert.equal(points,0,"favorites and opens are not scored");
    first.manager.deactivate();second.manager.deactivate();
    process.stdout.write("reader-library.smoke.passed http=real devices=2 favorites=save-delete-restore stale=delete-wins recent=merged replay=stable cursor=scoped pages=complete points=unchanged rollback=guarded\n");
  }finally{
    if(app)await app.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();
  }
}
main().catch(error=>{process.stderr.write(String(error.stack??error)+"\n");process.exitCode=1});
