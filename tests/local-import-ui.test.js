const test=require('node:test')
const assert=require('node:assert/strict')

test('Me page requires consent and stores only an acknowledged local-import receipt',async()=>{
  const previousWx=global.wx,storage=new Map(),toasts=[]
  global.wx={isBrowserPreview:true,__tingyueMode:'production',getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),getWindowInfo:()=>({statusBarHeight:24}),showToast:value=>toasts.push(value.title),navigateTo:()=>{},switchTab:()=>{}}
  const api=require('../miniprogram/services/api'),original={isAuthenticated:api.isAuthenticated,localImport:api.localImport,currentUser:api.currentUser}
  try{
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
    const saved=storage.get('tingyue.product.v1')
    assert.equal(saved.localImportReceipts[0].snapshotId,submitted.snapshotId)
    assert.deepEqual(saved.words,['Once'])
    assert.ok(toasts.includes('本机学习数据已确认'))
  }finally{api.isAuthenticated=original.isAuthenticated;api.localImport=original.localImport;api.currentUser=original.currentUser;global.wx=previousWx}
})
