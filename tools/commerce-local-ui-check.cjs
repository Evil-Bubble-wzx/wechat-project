// Browser-rendered native page code, with wx.request bridged to the real local
// API. Complements the IDE compile check; does not claim native taps were run.
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),servers=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let browser,pool,paidOrder,lastPage;
(async()=>{
  const {Pool}=require('../backend/node_modules/pg');
  const db=new URL(process.env.DATABASE_URL);
  if(process.env.APP_ENV!=='local'||db.hostname!=='127.0.0.1'||db.port!=='55433'||db.pathname!=='/tingyue')throw Error('Dedicated localhost database only');
  pool=new Pool({connectionString:process.env.DATABASE_URL});
  const {CommerceService}=await import('../backend/src/commerce/service.ts');
  const commerce=new CommerceService(pool);
  for(const [account,port] of [['primary',4194],['isolation',4195]]){
    servers.push(spawn(process.execPath,['tools/preview-server.js',`--mini-root=build/commerce-local-${account}/miniprogram`],{cwd:root,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:'ignore'}));
    for(let n=0;n<50;n++){try{if((await fetch(`http://127.0.0.1:${port}`)).ok)break;}catch{}await wait(100);}
  }
  browser=await chromium.launch({channel:'msedge',headless:true});
  async function pageFor(port){
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
    await page.exposeFunction('__localRequest',async options=>{
      const url=new URL(options.url);const asset=url.origin==='http://127.0.0.1:59000';if(!asset && (url.origin!=='http://127.0.0.1:3100'||!url.pathname.startsWith('/api/v1/')))throw Error('Unexpected request origin');
      const response=await fetch(url,{method:options.method||'GET',headers:options.header,body:options.data===undefined?undefined:JSON.stringify(options.data)});
      return {statusCode:response.status,data:asset?await response.text():await response.json(),header:Object.fromEntries(response.headers)};
    });
    await page.addInitScript(()=>{
      let value;Object.defineProperty(window,'wx',{configurable:true,get:()=>value,set:runtime=>{
        value=runtime;runtime.isBrowserPreview=false;runtime.getAccountInfoSync=()=>({miniProgram:{envVersion:'develop'}});
        runtime.request=options=>{window.__localRequest({url:options.url,method:options.method,header:options.header,data:options.data}).then(options.success,options.fail);return {abort(){}}};
      }});
    });
    lastPage=page;await page.goto(`http://127.0.0.1:${port}/#login`);console.log('ui.login.start port='+port);
    await page.locator('.agreement .checkbox').click();await page.locator('.login-button').click();
    await page.waitForFunction(()=>location.hash==='#home',{},{timeout:15000});
    console.log('ui.login.passed port='+port);await page.evaluate(()=>location.hash='me');await page.waitForSelector('.member-card');
    await page.getByRole('button',{name:'模拟内容包与订单 · 不收费'}).click();
    await page.waitForFunction(()=>window.currentPage.data.commerceBundles.length>0&&!window.currentPage.data.commerceBusy);
    console.log('ui.orders.loaded port='+port);return page;
  }
  const primary=await pageFor(4194),before=await primary.evaluate(()=>window.currentPage.data.commerceOrders.map(o=>o.orderId));
  await primary.getByRole('button',{name:'创建测试订单 · 不扣款',exact:true}).first().click();
  await primary.waitForFunction(()=>!window.currentPage.data.commerceBusy && window.currentPage.data.commerceOrders.some(o=>o.status==='pending'&&o.bundleId==='commerce-test-bundle'));
  const order=await primary.evaluate(()=>window.currentPage.data.commerceOrders.find(o=>o.status==='pending'&&o.bundleId==='commerce-test-bundle'));
  const count=await primary.evaluate(()=>window.currentPage.data.commerceOrders.length);
  await primary.getByRole('button',{name:'创建测试订单 · 不扣款',exact:true}).first().click();
  assert.equal(await primary.evaluate(()=>window.currentPage.data.commerceOrders.length),count);
  assert.equal(order.status,'pending');console.log('ui.order.created');
  await commerce.simulate(order.orderId,'pay','ui-pay-'+order.orderId,100);paidOrder=order.orderId;
  await primary.getByRole('button',{name:'刷新订单',exact:true}).click();
  await primary.waitForFunction(id=>window.currentPage.data.commerceOrders.find(o=>o.orderId===id)?.status==='paid',order.orderId);
  await primary.evaluate(id=>window.currentPage.checkCommerceAccess({currentTarget:{dataset:{id}}}),order.orderId);
  assert.equal(await primary.locator('#toast').innerText(),'服务端已确认该版本访问权限');
  await primary.evaluate(id=>window.currentPage.openCommerceReader({currentTarget:{dataset:{id}}}),order.orderId);
  assert.match(await primary.evaluate(()=>window.currentPage.data.commerceReaderText),/A small bird finds a blue stone/);
  await primary.screenshot({path:path.join(root,'.cache/device-local/commerce-reader-paid.png')});
  await primary.evaluate(()=>window.currentPage.backCommerceOrders());
  assert.equal(await primary.evaluate(()=>window.currentPage.data.commerceReaderText),'');
  const isolation=await pageFor(4195);
  assert.equal(await isolation.evaluate(id=>window.currentPage.data.commerceOrders.some(o=>o.orderId===id),order.orderId),false);
  await primary.screenshot({path:path.join(root,'.cache/device-local/commerce-local-paid.png')});
  await commerce.simulate(order.orderId,'refund','ui-refund-'+order.orderId,100);paidOrder=null;
  await primary.getByRole('button',{name:'刷新订单',exact:true}).click();
  await primary.waitForFunction(id=>window.currentPage.data.commerceOrders.find(o=>o.orderId===id)?.status==='refunded',order.orderId);
  await primary.evaluate(id=>window.currentPage.checkCommerceAccess({currentTarget:{dataset:{id}}}),order.orderId);
  // Another valid order legitimately retains access; the isolated backend smoke
  // separately verifies sole-order revocation.
  const user=(await pool.query('SELECT user_id FROM purchase_orders WHERE id=$1',[order.orderId])).rows[0].user_id;
  const retained=await commerce.canAccess(user,'commerce-test-piece',1);
  const message=await primary.locator('#toast').innerText();assert.equal(message,retained?'服务端已确认该版本访问权限':'当前订单没有有效访问权限');
  await primary.evaluate(id=>window.currentPage.openCommerceReader({currentTarget:{dataset:{id}}}),order.orderId);
  if(!retained){assert.equal(await primary.evaluate(()=>window.currentPage.data.commerceReaderText),'');assert.match(await primary.evaluate(()=>window.currentPage.data.commerceReaderError),/没有有效访问权限/);}
  await primary.screenshot({path:path.join(root,'.cache/device-local/commerce-local-refunded.png')});
  console.log('commerce.local.ui.passed: real API login, UI order creation, paid refresh, access check, isolated account, refund refresh; no mocked order data');
})().catch(async e=>{if(lastPage)await lastPage.screenshot({path:path.join(root,'.cache/device-local/commerce-ui-failure.png')});console.error(e.stack);process.exitCode=1}).finally(async()=>{
  if(paidOrder&&pool){const {CommerceService}=await import('../backend/src/commerce/service.ts');await new CommerceService(pool).simulate(paidOrder,'refund','ui-cleanup-'+paidOrder,100);}
  if(browser)await browser.close();if(pool)await pool.end();for(const s of servers)s.kill();
});
