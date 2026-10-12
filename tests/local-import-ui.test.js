const test=require('node:test')
const assert=require('node:assert/strict')

test('Me page requires consent and stores only an acknowledged local-import receipt',async()=>{
  const previousWx=global.wx,storage=new Map(),toasts=[]
  global.wx={isBrowserPreview:true,__tingyueMode:'production',getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),getWindowInfo:()=>({statusBarHeight:24}),showToast:value=>toasts.push(value.title),navigateTo:()=>{},switchTab:()=>{}}
  const api=require('../miniprogram/services/api'),original={isAuthenticated:api.isAuthenticated,localImport:api.localImport,currentUser:api.currentUser}
  const host=require('../miniprogram/services/host'),previousScope=host.accountScope()
  try{
    host.setAccountScope('user-1')
    api.isAuthenticated=()=>true
    api.currentUser=()=>({userId:'user-1'})
    let submitted
    api.localImport=async request=>{submitted=request;return {snapshotId:request.snapshotId,status:'completed',duplicate:false,summary:{progress:{accepted:0,unchanged:0,rejected:0},words:{pending:1,reused:0,rejected:0},quizAttempts:{verified:0,rejected:0}},items:{progress:[],words:[{surface:'Once',status:'pending_resolution'}],quizAttempts:[]},acknowledgedAt:'2026-09-28T08:00:00.000Z'}}
    const {createPage}=require('../miniprogram/ui/controller'),page=createPage('me')
    page.setData=patch=>Object.assign(page.data,patch)
    page.state={favorites:[],recent:[],progress:{},results:[],words:['Once'],listeningSec:0,listenDaily:{}}
    storage.set('tingyue.product.v1',JSON.parse(JSON.stringify(page.state)))
    page.stateBaseline=JSON.parse(JSON.stringify(page.state))
    page.openLocalImport()
    assert.equal(page.data.sheet,'localImport');assert.equal(page.data.localImportReady,true);assert.equal(page.data.localImportConsented,false)
    await page.submitLocalImport();assert.equal(submitted,undefined)
    page.toggleLocalImportConsent();await page.submitLocalImport()
    assert.match(submitted.snapshotId,/^s01-v1:[a-f0-9]{64}$/)
    assert.equal(page.data.localImportReceipt.status,'completed')
    const saved=storage.get('tingyue.product.v1').accountLearning['user-1']
    assert.equal(saved.localImportReceipts[0].snapshotId,submitted.snapshotId)
    assert.deepEqual(storage.get('tingyue.product.v1').words,['Once'])
    assert.ok(toasts.includes('本机学习数据已确认'))
  }finally{host.setAccountScope(previousScope);api.isAuthenticated=original.isAuthenticated;api.localImport=original.localImport;api.currentUser=original.currentUser;global.wx=previousWx}
})

for(const outcome of ['success','failure'])test('local-import ignores late '+outcome+' after switching accounts',async()=>{
  const previousWx=global.wx,storage=new Map(),toasts=[]
  global.wx={isBrowserPreview:true,__tingyueMode:'production',getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),getWindowInfo:()=>({statusBarHeight:24}),showToast:value=>toasts.push(value.title)}
  const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host'),progress=require('../miniprogram/modules/sync/progress-sync')
  const original={available:api.available,isAuthenticated:api.isAuthenticated,currentUser:api.currentUser,localImport:api.localImport,pullAll:progress.pullAll},previousScope=host.accountScope()
  let userId='account-a',resolve,reject,request
  try{
    api.available=()=>false;api.isAuthenticated=()=>true;api.currentUser=()=>({userId});progress.pullAll=async()=>{}
    api.localImport=value=>{request=value;return new Promise((yes,no)=>{resolve=yes;reject=no})}
    storage.set('tingyue.product.v1',{words:['Once'],accountLearning:{'account-a':{},'account-b':{words:['B-only'],results:[]}}})
    host.setAccountScope(userId)
    const page=require('../miniprogram/ui/controller').createPage('me');page.setData=patch=>Object.assign(page.data,patch);page.refresh();page.openLocalImport();page.toggleLocalImportConsent()
    const pending=page.submitLocalImport();await Promise.resolve();await Promise.resolve()
    userId='account-b';host.setAccountScope(userId);page.refresh();const before=JSON.stringify(host.read()),toastCount=toasts.length
    if(outcome==='failure')reject(new Error('offline'));else resolve({snapshotId:request.snapshotId,status:'completed',duplicate:false,items:{quizAttempts:[]},summary:{},acknowledgedAt:new Date().toISOString()})
    await pending
    assert.equal(JSON.stringify(host.read()),before);assert.equal(toasts.length,toastCount);assert.equal(page.data.localImportReceipt,null)
  }finally{host.setAccountScope(previousScope);Object.assign(api,{available:original.available,isAuthenticated:original.isAuthenticated,currentUser:original.currentUser,localImport:original.localImport});progress.pullAll=original.pullAll;global.wx=previousWx}
})
