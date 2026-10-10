const test=require('node:test')
const assert=require('node:assert/strict')

test('signed text is fetched without account credentials and rejects expired assets',async()=>{
  const {readText}=require('../miniprogram/services/commerce-reader');let request
  const asset={type:'text',mimeType:'text/plain',sizeBytes:10,url:'https://assets.example/test?signature=x',expiresAt:new Date(Date.now()+60000).toISOString()}
  const runtime={request:r=>{request=r;r.success({statusCode:200,data:'test text'})}}
  assert.equal(await readText({assets:[asset]},runtime),'test text');assert.deepEqual(request.header,{});assert.equal(request.dataType,'text')
  await assert.rejects(readText({assets:[{...asset,expiresAt:'2000-01-01'}]},runtime))
})

test('closing a protected reader drops late text and a denied reopen clears old text',async()=>{
  const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host'),reader=require('../miniprogram/services/commerce-reader')
  const originals=[api.currentUser,api.isAuthenticated,api.getManifest,host.accountScope,reader.readText,global.wx];let resolveText
  const user={userId:'reader-user'}
  try{
    global.wx={};api.currentUser=()=>user;api.isAuthenticated=()=>true;host.accountScope=()=>user.userId;api.getManifest=async()=>({});reader.readText=()=>new Promise(r=>resolveText=r)
    const page=require('../miniprogram/ui/controller').createPage('me');page.setData=p=>Object.assign(page.data,p);page.data.showCommerceTest=true;page.data.commerceOrders=[{orderId:'order',contents:[{pieceId:'sample',contentVersion:1}]}]
    const e={currentTarget:{dataset:{id:'order'}}};const pending=page.openCommerceReader(e);await Promise.resolve();page.clearCommerceReader();page.data.sheet='';resolveText('private text');await pending;assert.equal(page.data.commerceReaderText,'')
    page.data.commerceReaderText='old private text';api.getManifest=async()=>{throw {statusCode:403}};await page.openCommerceReader(e);assert.equal(page.data.commerceReaderText,'');assert.match(page.data.commerceReaderError,/没有有效访问权限/)
  }finally{[api.currentUser,api.isAuthenticated,api.getManifest,host.accountScope,reader.readText,global.wx]=originals}
})
test('a confirmed pending order prevents repeated purchases even if list refresh fails',async()=>{
  const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host')
  const names=['currentUser','isAuthenticated','createOrder','listOrders','listBundles'],original=Object.fromEntries(names.map(n=>[n,api[n]])),scope=host.accountScope,toast=host.toast
  const user={userId:'same-user'};let creates=0
  try{
    api.currentUser=()=>user;api.isAuthenticated=()=>true;host.accountScope=()=>user.userId;host.toast=()=>{}
    api.createOrder=async()=>{creates++;return {order:{orderId:'order-one',bundleId:'bundle',bundleVersion:1,status:'pending'}}}
    api.listOrders=async()=>{throw Error('temporary list failure')};api.listBundles=async()=>({items:[]})
    const page=require('../miniprogram/ui/controller').createPage('me');page.setData=p=>Object.assign(page.data,p);page.data.showCommerceTest=true;page.data.commerceBundles=[{bundleId:'bundle',version:1}]
    const event={currentTarget:{dataset:{id:'bundle',version:'1'}}}
    await page.createCommerceOrder(event);await page.createCommerceOrder(event);await page.createCommerceOrder(event)
    assert.equal(creates,1);assert.equal(page.data.commerceOrders[0].orderId,'order-one')
  }finally{for(const n of names)api[n]=original[n];host.accountScope=scope;host.toast=toast}
})
test('commerce discards orders and payment checks after account change or page unload',async()=>{
  const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host')
  const original={currentUser:api.currentUser,isAuthenticated:api.isAuthenticated,listBundles:api.listBundles,listOrders:api.listOrders,getManifest:api.getManifest,accountScope:host.accountScope,toast:host.toast}
  let user={userId:'a'},scope='a',resolveOrders,resolveManifest;const toasts=[]
  try{
    api.currentUser=()=>user;api.isAuthenticated=()=>true;host.accountScope=()=>scope;host.toast=m=>toasts.push(m)
    api.listBundles=async()=>({items:[]});api.listOrders=()=>new Promise(r=>resolveOrders=r)
    const page=require('../miniprogram/ui/controller').createPage('me');page.setData=p=>Object.assign(page.data,p);page.data.showCommerceTest=true
    const pending=page.refreshCommerceTest();user={userId:'b'};scope='b';page.resetCommerceTest();resolveOrders({items:[{orderId:'private-a-order'}]});await pending
    assert.deepEqual(page.data.commerceOrders,[]);assert.equal(page.data.commerceBusy,false)
    page.data.commerceOrders=[{orderId:'b-order',contents:[{pieceId:'sample',contentVersion:1}]}]
    api.getManifest=()=>new Promise(r=>resolveManifest=r)
    const check=page.checkCommerceAccess({currentTarget:{dataset:{id:'b-order'}}});page.commerceEpoch++;resolveManifest({});await check;assert.deepEqual(toasts,[])
  }finally{for(const k of ['currentUser','isAuthenticated','listBundles','listOrders','getManifest'])api[k]=original[k];host.accountScope=original.accountScope;host.toast=original.toast}
})
