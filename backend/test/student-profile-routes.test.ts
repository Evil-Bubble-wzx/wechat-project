import assert from "node:assert/strict";
import test from "node:test";
import {createApp} from "../src/api/app.ts";
import {ApiError} from "../src/api/errors.ts";
import {parseProfileMutation} from "../src/api/student-profile-routes.ts";
const code="student_"+"a".repeat(32),input={mutationId:"profile-test-1",baseRevision:"0",campusId:"a",grade:"3",readingLevel:"2",reason:"School record verified"};
function fixture(){
 const calls:any[]=[];
 const sessions:any={authenticateAccessToken:async(token:string)=>({userId:token,sessionId:"test-session"})};
 const service:any={assertManager:async(id:string)=>{calls.push(["authorize",id]);if(id!=="ops")throw new ApiError("FORBIDDEN",403,false,"Operations required")},
  me:async(id:string)=>{calls.push(["me",id]);return{profile:{studentCode:code},canManage:id==="ops"}},
  options:async()=>({campuses:[],grades:[],readingLevels:[],cohortPolicy:"period_start"}),
  get:async(...args:any[])=>{calls.push(["get",...args]);return{profile:{studentCode:code}}},
  update:async(...args:any[])=>{calls.push(["update",...args]);return{status:"applied",profile:{studentCode:code}}}};
 return{calls,service,sessions,app:createApp({sessionService:sessions,studentProfileService:service})};
}
test("all student profile routes authenticate before revealing or parsing data",async()=>{
 const{app,calls}=fixture();try{
  for(const[method,url]of [["GET","/api/v1/me/student-profile"],["GET","/api/v1/admin/student-profile-options"],["GET","/api/v1/admin/student-profiles/"+code],["PUT","/api/v1/admin/student-profiles/"+code]]as const){
   assert.equal((await app.inject({method,url})).statusCode,401);
  }assert.deepEqual(calls,[]);
 }finally{await app.close()}
});
test("ordinary and content-only accounts cannot use operations profile endpoints",async()=>{
 const{app,calls}=fixture();try{
  for(const actor of ["reader","content_admin"])for(const method of ["GET","PUT"]as const){
   const response=await app.inject({method,url:"/api/v1/admin/student-profiles/not-a-code",headers:{authorization:"Bearer "+actor},...(method==="PUT"?{payload:{userId:"foreign"}}:{})});
   assert.equal(response.statusCode,403);
  }assert.equal(calls.some(c=>c[0]==="get"||c[0]==="update"),false);
 }finally{await app.close()}
});
test("self read uses authenticated identity and rejects query account injection",async()=>{
 const{app,calls}=fixture();try{
  const headers={authorization:"Bearer reader"};
  assert.equal((await app.inject({method:"GET",url:"/api/v1/me/student-profile?userId=other",headers})).statusCode,400);
  const response=await app.inject({method:"GET",url:"/api/v1/me/student-profile",headers});
  assert.equal(response.statusCode,200);assert.deepEqual(calls,[["me","reader"]]);assert.equal(response.json().canManage,false);
  assert.match(response.json().requestId,/^[a-f0-9-]{36}$/);
 }finally{await app.close()}
});
test("profile parser rejects derived verification, invalid grade, timestamp and revision fields",()=>{
 assert.deepEqual(parseProfileMutation(input),input);
 assert.deepEqual(parseProfileMutation({...input,campusId:null,grade:null,readingLevel:null}),{...input,campusId:null,grade:null,readingLevel:null});
 for(const bad of [{...input,grade:"10"},{...input,readingLevel:"6"},{...input,campusId:null},{...input,source:"school_sync"},
  {...input,effectiveFrom:"2000-01-01"},{...input,verifiedAt:"2000-01-01"},{...input,userId:"foreign"},{...input,baseRevision:0},
  {...input,reason:""},{...input,reason:" trailing "},{...input,reason:"control\ntext"},{...input,mutationId:"short"}])
  assert.throws(()=>parseProfileMutation(bad),/invalid/);
});
test("operations update requires matching idempotency and forwards only server actor and parsed mutation",async()=>{
 const{app,calls}=fixture();try{
  const headers={authorization:"Bearer ops","idempotency-key":input.mutationId},url="/api/v1/admin/student-profiles/"+code;
  assert.equal((await app.inject({method:"PUT",url,headers:{...headers,"idempotency-key":"different"},payload:input})).statusCode,400);
  assert.equal((await app.inject({method:"PUT",url:url+"?source=school_sync",headers,payload:input})).statusCode,400);
  const response=await app.inject({method:"PUT",url,headers,payload:input});assert.equal(response.statusCode,200);
  const forwarded=calls.find(c=>c[0]==="update");assert.deepEqual(forwarded.slice(1,4),["ops",code,input]);assert.equal(forwarded[4],response.json().requestId);
 }finally{await app.close()}
});
test("student profile routes require an authenticated session dependency",()=>{
 const{service}=fixture();assert.throws(()=>createApp({studentProfileService:service}),/session service/);
});
