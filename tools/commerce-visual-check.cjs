const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const server=spawn(process.execPath,['tools/preview-server.js','--mini-root=build/commerce-local-primary/miniprogram'],{cwd:root,env:{...process.env,PORT:'4193'},windowsHide:true,stdio:'ignore'});
let browser;
(async()=>{
  for(let n=0;n<50;n++){try{if((await fetch('http://127.0.0.1:4193')).ok)break;}catch{}await wait(100);}
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:4193/#me');await page.waitForSelector('.member-card');
  await page.evaluate(()=>window.currentPage.setData({showCommerceTest:true,sheet:'commerceTest',commerceBundles:[{bundleId:'commerce-test-bundle',version:1,title:'模拟内容包 · 不收费',priceLabel:'¥1.00'}],commerceOrders:[{orderId:'00000000-0000-4000-8000-000000000001',title:'模拟内容包 · 不收费',statusLabel:'已退款',contents:[{pieceId:'commerce-test-piece',contentVersion:1}]}]}));
  const panel=page.locator('.sheet');await panel.waitFor();if(!(await panel.innerText()).includes('不会扣款'))throw Error('Simulation label missing');
  await page.screenshot({path:path.join(root,'.cache/device-local/commerce-mobile.png')});
  const overflow=await panel.evaluate(e=>e.scrollWidth>e.clientWidth+1);if(overflow||errors.length)throw Error(JSON.stringify({overflow,errors}));
  console.log('commerce.visual.passed: mobile sheet renders without horizontal overflow; fixture screenshot saved');
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();server.kill();});
