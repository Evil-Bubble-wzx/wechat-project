const test=require('node:test'),assert=require('node:assert/strict')
const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host'),profiles=require('../miniprogram/modules/profile/student-profile'),{createPage}=require('../miniprogram/ui/controller')
const code='student_'+'a'.repeat(32)
const profile=(patch={})=>({studentCode:code,revision:'0',status:'unassigned',campusId:null,campusName:null,campusActive:null,grade:null,readingLevel:null,source:'unverified',verifiedAt:null,effectiveFrom:null,...patch})
async function harness(run){
 const oldWx=global.wx,oldScope=host.accountScope(),saved={},writes=[];let userId='operator-a',update=async(_,request)=>({status:'applied',profile:profile({revision:'1',status:'verified',campusId:request.campusId,campusName:'A校区',campusActive:true,grade:request.grade,readingLevel:request.readingLevel,source:'admin',verifiedAt:'2026-10-12T01:00:00Z',effectiveFrom:'2026-10-12T01:00:00Z'})})
 for(const key of ['available','isAuthenticated','currentUser','studentProfileAvailable','studentProfile','studentProfileOptions','findStudentProfile','updateStudentProfile'])saved[key]=api[key]
 global.wx={getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getStorageSync:()=>null,setStorageSync:(...args)=>writes.push(args),getWindowInfo:()=>({statusBarHeight:24}),showToast:()=>{}}
 host.setAccountScope(userId);api.available=()=>true;api.isAuthenticated=()=>!!userId;api.currentUser=()=>({userId});api.studentProfileAvailable=()=>true
 api.studentProfile=async()=>({profile:profile(),canManage:true})
 api.studentProfileOptions=async()=>({campuses:[{value:'a',label:'A校区'},{value:'b',label:'B校区'}],grades:[{value:'3',label:'Grade 3'}],readingLevels:[{value:'2',label:'Lv 2.x'}],cohortPolicy:'period_start'})
 api.findStudentProfile=async()=>({profile:profile()});api.updateStudentProfile=(...args)=>update(...args)
 const page=createPage('student-profile');page.setData=patch=>Object.assign(page.data,patch);page.onLoad()
 try{await page.bootstrap();await run({page,writes,setUser:id=>{userId=id;host.setAccountScope(id)},setUpdate:fn=>update=fn,prepare:async()=>{page.typeCode({detail:{value:code}});await page.lookup();page.chooseCampus({detail:{value:1}});page.chooseGrade({detail:{value:1}});page.chooseLevel({detail:{value:1}});page.typeReason({detail:{value:'核对学校档案'}});page.confirm()}})}
 finally{Object.assign(api,saved);host.setAccountScope(oldScope);global.wx=oldWx}
}
test('ordinary accounts cannot expose the profile management form',async()=>{await harness(async({page})=>{api.studentProfile=async()=>({profile:profile(),canManage:false});await page.bootstrap();assert.equal(page.data.canManage,false);assert.equal(page.data.status,'forbidden')})})
test('profile view preserves exact revision and unknown values without identity leakage',()=>{
 const p=profiles.normalize(profile({revision:'90071992547409930',userId:'secret',phone:'secret'}));assert.equal(p.revision,'90071992547409930');assert.equal(p.gradeLabel,'Pending');assert.equal(p.levelLabel,'Pending');assert.equal(p.verifiedLabel,'—');assert.equal(JSON.stringify(p).includes('secret'),false)
})
test('staff must confirm identity and provide a reason before a revision-bound update',async()=>{
 await harness(async({page,prepare,setUpdate,writes})=>{await prepare();let calls=0;setUpdate(async(c,r)=>{calls++;assert.equal(c,code);assert.equal(r.baseRevision,'0');assert.equal(r.campusId,'a');assert.equal(r.grade,'3');assert.equal(r.readingLevel,'2');assert.equal('source'in r,false);return{status:'applied',profile:profile({revision:'1'})}})
 page.data.confirmed=false;await page.save();assert.equal(calls,0);page.confirm();await page.save();assert.equal(calls,1);assert.equal(page.data.profile.revision,'1');assert.deepEqual(writes,[])})
})
test('network retry retains the same immutable mutation and locks editing',async()=>{
 await harness(async({page,prepare,setUpdate})=>{await prepare();let original;setUpdate(async(c,r)=>{original=r;throw Error('offline')});await page.save();assert.ok(page.pending);page.typeReason({detail:{value:'do not change'}});assert.equal(page.data.reason,'核对学校档案')
 setUpdate(async(c,r)=>{assert.equal(r,original);return{status:'applied',profile:profile({revision:'1'})}});await page.retry();assert.equal(page.pending,null);assert.equal(page.data.locked,false)})
})
test('conflict does not overwrite newer staff data or silently retry with a new base',async()=>{
 await harness(async({page,prepare,setUpdate})=>{await prepare();let calls=0;setUpdate(async()=>{calls++;throw Object.assign(Error('stale'),{serverCode:'CONFLICT'})});await page.save();assert.equal(page.data.status,'conflict');assert.equal(page.data.locked,true);assert.equal(page.pending,null);await page.save();assert.equal(calls,1)
 api.findStudentProfile=async()=>({profile:profile({revision:'2'})});await page.reload();assert.equal(page.data.profile.revision,'2');assert.equal(page.data.confirmed,false)})
})
test('clearing assignment sends null fields; inactive campuses are not silently cleared',async()=>{
 await harness(async({page,prepare,setUpdate})=>{await prepare();page.chooseCampus({detail:{value:0}});page.confirm();let calls=0;setUpdate(async(c,r)=>{calls++;assert.equal(r.campusId,null);assert.equal(r.grade,null);assert.equal(r.readingLevel,null);return{status:'applied',profile:profile({revision:'1'})}});await page.save();assert.equal(calls,1)
 page.options.campuses=[{value:'b',label:'B校区'}];page.setProfile(profile({campusId:'a',campusName:'A校区',campusActive:false}));page.data.reason='核对';page.data.confirmed=true;await page.save();assert.equal(calls,1);assert.ok(page.data.notice.includes('有效'))})
})
test('account switch, unload and role revocation remove private form and pending mutation',async()=>{
 await harness(async({page,prepare,setUpdate,setUser})=>{await prepare();let resolve;setUpdate(()=>new Promise(done=>resolve=done));const loading=page.save();setUser('operator-b');resolve({status:'applied',profile:profile({revision:'1'})});await loading;page.onShow();assert.equal(page.data.profile,null);assert.equal(page.data.studentCode,'');assert.equal(page.pending,null)})
 await harness(async({page,prepare,setUpdate})=>{await prepare();let reject;setUpdate(()=>new Promise((done,fail)=>reject=fail));const loading=page.save();page.onUnload();reject(Error('late'));await loading;assert.equal(page.data.notice,'')})
 await harness(async({page,prepare,setUpdate})=>{await prepare();setUpdate(async()=>{throw Object.assign(Error('revoked'),{serverCode:'FORBIDDEN'})});await page.save();assert.equal(page.data.profile,null);assert.equal(page.data.canManage,false);assert.equal(page.pending,null)})
})
test('Me profile replies cannot cross accounts or restore an unloaded page',async()=>{
 await harness(async({setUser})=>{const page=createPage('me');page.setData=patch=>Object.assign(page.data,patch);let resolve;api.studentProfile=()=>new Promise(done=>resolve=done);const loading=page.loadStudentProfile();setUser('other-reader');resolve({profile:profile(),canManage:true});await loading;assert.equal(page.data.studentProfile,null)})
 await harness(async()=>{const page=createPage('me');page.setData=patch=>Object.assign(page.data,patch);let resolve;api.studentProfile=()=>new Promise(done=>resolve=done);const loading=page.loadStudentProfile();page.onUnload();resolve({profile:profile(),canManage:true});await loading;assert.equal(page.data.studentProfile,null)})
})
test('foreground recovery reloads the latest profile without resending an unconfirmed write',async()=>{
 await harness(async({page,prepare,setUpdate})=>{await prepare();let resolve,calls=0;setUpdate(()=>{calls++;return new Promise(done=>resolve=done)});const loading=page.save();page.onHide()
 api.findStudentProfile=async()=>({profile:profile({revision:'2'})});await page.onShow();assert.equal(page.pending,null);assert.equal(page.data.profile.revision,'2')
 resolve({status:'applied',profile:profile({revision:'1'})});await loading;assert.equal(page.data.profile.revision,'2');assert.equal(calls,1);assert.equal(page.data.confirmed,false)})
})
test('profile adapter gates observed contract and uses a revision-bound PUT with stable idempotency',async()=>{
 const oldScope=host.accountScope(),requests=[],storage=new Map();let version='api-contract-v2.4.0'
 const client=api.createBackendApi({configuration:{enabled:true,apiRoot:'https://api.example.test/api/v1',contractVersion:'api-contract-v2.5.0'},
 runtime:{login:({success})=>success({code:'test:profile-adapter'}),getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v)},maxRetries:0,
 transport:async request=>{requests.push(request);const path=new URL(request.url).pathname;let data
  if(path.endsWith('/session/wechat'))data={userId:'reader',accessToken:'access',refreshToken:'refresh'}
  else if(path.endsWith('/me'))data={userId:'reader',status:'active',profile:{}}
  else data={profile:profile(),status:'applied',canManage:false}
  return{statusCode:path.endsWith('/session/wechat')?201:200,data,headers:{'X-API-Contract-Version':version}}}})
 try{
  await client.loginWechat();assert.equal(client.studentProfileAvailable(),false);version='api-contract-v2.5.0';await client.getMe();assert.equal(client.studentProfileAvailable(),true)
  const mutation={mutationId:'profile-fixed-id',baseRevision:'90071992547409930',campusId:'a',grade:'3',readingLevel:'2',reason:'核对'}
  await client.updateStudentProfile(code,mutation);const request=requests.at(-1);assert.equal(request.method,'PUT');assert.ok(request.url.endsWith('/admin/student-profiles/'+code));assert.equal(request.headers['Idempotency-Key'],mutation.mutationId);assert.deepEqual(request.body,mutation)
  assert.equal([...storage.values()].some(v=>v==='access'||v==='refresh'),false)
 }finally{host.setAccountScope(oldScope)}
})
