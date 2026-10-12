const test=require('node:test'),assert=require('node:assert/strict')
const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host')
const detail=require('../miniprogram/ui/ranking-detail'),{createPage}=require('../miniprogram/ui/controller')
const snapshotId='00000000-0000-4000-8000-000000000010'
const ctx={snapshotId,participantId:'reader_test_001',campusId:'a',periodType:'rolling7',grade:'3',level:'all'}
function response(query='',sort='date',direction='desc',quizzes=[],nextCursor=null){
 return{snapshotId,participant:{participantId:ctx.participantId,displayName:'Reader 001',gradeLabel:'Grade 3',readingLevelLabel:'Lv 3.x',userId:'secret'},rankingScore:'90071992547409930',scoreBreakdown:[],startsAt:'2026-10-03T05:00:00Z',endsAt:'2026-10-10T05:00:00Z',stats:{schemaVersion:1,attempts:52,passedAttempts:30,passed:{pieces:2,words:null},all:{pieces:6,words:'12300'}},quizzes,search:{query,sort,direction},totalMatches:52,nextCursor}
}
async function harness(run){
 const oldWx=global.wx,oldScope=host.accountScope(),saved={};let userId='account-a',request=async()=>response(),url=''
 for(const key of ['available','isAuthenticated','currentUser','rankingAnalysisAvailable','rankingAnalysis'])saved[key]=api[key]
 global.wx={getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getStorageSync:()=>null,showToast:()=>{},navigateTo:options=>url=options.url}
 host.setAccountScope(userId);api.available=()=>true;api.isAuthenticated=()=>true;api.currentUser=()=>({userId});api.rankingAnalysisAvailable=()=>true;api.rankingAnalysis=(...args)=>request(...args)
 const page=createPage('ranking-detail');page.setData=patch=>Object.assign(page.data,patch);page.onLoad(ctx)
 try{await run({page,setRequest:fn=>request=fn,setUser:id=>{userId=id;host.setAccountScope(id)},url:()=>url})}finally{Object.assign(api,saved);host.setAccountScope(oldScope);global.wx=oldWx}
}
test('ranking navigates to a standalone page carrying exact snapshot and original filters',async()=>{
 await harness(async h=>{
  const list=createPage('ranking');list.setData=patch=>Object.assign(list.data,patch);list.data.rankingStatus='ready';list.data.rankingSnapshotId=snapshotId;list.rankingDataOwner='account-a';list.rankingScopeFilters={...ctx,participantId:undefined}
  assert.equal(list.openRankingDetail({currentTarget:{dataset:{id:ctx.participantId}}}),true)
  assert.match(h.url(),/^\/pages\/ranking-detail\/index\?/);assert.ok(h.url().includes(snapshotId));assert.ok(h.url().includes('grade=3'))
  h.setUser('account-b');assert.equal(list.openRankingDetail({currentTarget:{dataset:{id:ctx.participantId}}}),false)
 })
})
test('details map only anonymous fields, preserve exact points and unknown values',async()=>{
 await harness(async({page,setRequest})=>{
  setRequest(async()=>response('','date','desc',[{attemptId:'x',title:'Story',takenAt:'2026-10-10T01:00:00Z',correctPercent:90,level:null,wordCount:null,passed:true,quizPoints:'90071992547409930',contentVersion:1,selectedOptions:[0],phone:'secret'}]))
  await page.load();assert.equal(page.data.status,'ready');assert.equal(page.data.quizzes[0].wordsLabel,'—');assert.equal(page.data.quizzes[0].takenAt,'2026-10-10 09:00')
  assert.equal(page.data.detail.rankingScore,'90,071,992,547,409,930');assert.equal(JSON.stringify(page.data).includes('secret'),false);assert.equal(JSON.stringify(page.data).includes('selectedOptions'),false)
  assert.equal(page.data.statsRows.find(row=>row.key==='words').passed,'—')
 })
})
test('search and sorting reset pagination, retain the snapshot, and reject late replies',async()=>{
 await harness(async({page,setRequest})=>{
  let resolve;setRequest(()=>new Promise(done=>resolve=done));const old=page.load()
  page.typeQuery({detail:{value:'Author'}});setRequest(async(id,filters)=>{assert.equal(filters.snapshotId,snapshotId);assert.equal(filters.query,'Author');return response('Author')})
  await page.search();resolve(response());await old;assert.equal(page.data.appliedQuery,'Author');assert.equal(page.data.status,'ready')
  setRequest(async(id,filters)=>response('Author','words',filters.direction));await page.chooseSort({detail:{value:4}});await page.toggleDirection();assert.equal(page.data.direction,'asc')
 })
})
test('pagination keeps loaded rows on failure, retries the same cursor and deduplicates records',async()=>{
 await harness(async({page,setRequest})=>{
  const row={attemptId:'x',title:'X',takenAt:'2026-10-10T01:00:00Z',wordCount:1,passed:true,quizPoints:'0'}
  setRequest(async()=>response('','date','desc',[row],'page-2'));await page.load()
  setRequest(async()=>{throw Error('offline')});await page.more();assert.equal(page.data.quizzes.length,1);assert.equal(page.data.nextCursor,'page-2')
  setRequest(async(id,filters)=>{assert.equal(filters.cursor,'page-2');return response('','date','desc',[row,{...row,attemptId:'y'}])});await page.retry();assert.equal(page.data.quizzes.length,2)
 })
})
test('account changes and unload discard successful and failed late replies',async()=>{
 await harness(async({page,setRequest,setUser})=>{
  let resolve;setRequest(()=>new Promise(done=>resolve=done));const loading=page.load();setUser('account-b');resolve(response());await loading;assert.equal(page.data.detail,null)
  page.onShow();assert.deepEqual(page.data.quizzes,[]);assert.equal(page.data.status,'unauthenticated')
 })
 await harness(async({page,setRequest})=>{
  let reject;setRequest(()=>new Promise((done,fail)=>reject=fail));const loading=page.load();page.onUnload();reject(Error('offline'));await loading;assert.equal(page.data.notice,'')
 })
})
test('unsupported backends and invalid snapshot identity never show fabricated statistics',async()=>{
 await harness(async({page,setRequest})=>{
  api.rankingAnalysisAvailable=()=>false;await page.load();assert.equal(page.data.status,'unavailable');assert.equal(page.data.detail,null)
  api.rankingAnalysisAvailable=()=>true;setRequest(async()=>({...response(),snapshotId:'other'}));await page.load();assert.equal(page.data.status,'error');assert.equal(page.data.detail,null)
 })
 assert.equal(detail.context({campusId:'a'}),null)
})

test('returning to ranking restores period and filters only for the originating account',async()=>{
 await harness(async h=>{
  const old=api.rankingOptions
  try{
   detail.navigate({...ctx,periodType:'week',periodKey:'2026-W39'})
   api.rankingOptions=async()=>({campuses:[{value:'a',label:'A'}],periodTypes:[{value:'week',label:'周榜'}],periods:{week:[{key:'2026-W40',label:'40'},{key:'2026-W39',label:'39'}]},grades:[{value:'3',label:'3'}],levels:[{value:'all',label:'all'}]})
   const list=createPage('ranking');list.setData=patch=>Object.assign(list.data,patch)
   list.loadRankings=async()=>{}
   await list.loadRankingOptions();assert.equal(list.rankingFilters().campusId,'a');assert.equal(list.rankingFilters().periodKey,'2026-W39');assert.equal(list.rankingFilters().grade,'3')
   assert.equal(detail.returnFilters('account-b'),null)
  }finally{api.rankingOptions=old}
 })
})
