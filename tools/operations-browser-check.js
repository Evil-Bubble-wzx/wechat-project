const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async function operationsBrowser(address,accessToken,input,files,hooks){
 const browser=await chromium.launch({headless:true,channel:'msedge'}),page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[],puts=[];let interrupted=false;
 page.on('pageerror',()=>errors.push('browser-script-error'));
 const connect=async()=>{await page.locator('#token').fill(accessToken);await page.locator('#connect-form button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('account').textContent.includes('已连接'));};
 const choose=async(bad=false)=>{for(const file of files)await page.locator('#file-'+file.type).setInputFiles({name:file.fileName,mimeType:file.mimeType,buffer:bad&&file.type==='subtitles'?Buffer.alloc(file.bytes.length,48):file.bytes});};
 const idle=()=>page.waitForFunction(()=>document.getElementById('pause').disabled,{},{timeout:90000});
 try{
  const response=await page.goto(address+'/operations/');assert.equal(response.status(),200);await connect();
  for(const [key,value]of Object.entries({workId:input.workId,pieceId:input.pieceId,version:String(input.contentVersion),source:input.source,sourceCommitSha:input.sourceCommitSha}))await page.locator('#'+key).fill(value);
  await choose();await page.locator('#create').click();await page.waitForFunction(()=>document.getElementById('batchId').value.length===36,{},{timeout:90000});await idle();
  const batchId=await page.locator('#batchId').inputValue();
  await page.route('http://127.0.0.1:9000/**',async route=>{
   assert.equal(route.request().headers().authorization,undefined);const url=new URL(route.request().url());if(route.request().method()==='PUT'){
    const part=Number(url.searchParams.get('partNumber'));puts.push({part,file:url.pathname.split('/').pop()});
    if(part===2&&!interrupted){interrupted=true;await route.abort();return;}
   }await route.continue();
  });
  await page.locator('#upload').click();await idle();assert.ok(interrupted);assert.ok((await page.locator('#notice').textContent()).includes('操作未完成'));await hooks.expire(batchId);
  await page.reload();await connect();await page.locator('#draft').click();await idle();assert.equal(await page.locator('#batchId').inputValue(),batchId);
  await choose(true);const before=puts.length;await page.locator('#upload').click();await idle();assert.ok((await page.locator('#notice').textContent()).includes('FILE_CHECKSUM_MISMATCH'));assert.equal(puts.length,before);
  await choose();await hooks.armCompletionFailure(batchId);await page.locator('#upload').click();await idle();const completionNotice=await page.locator('#notice').textContent();assert.ok(completionNotice.includes('INTERNAL_ERROR'),completionNotice);await hooks.assertDurableIntent(batchId);
  await page.locator('#upload').click();await idle();assert.ok((await page.locator('#notice').textContent()).includes('上传完成'));assert.equal(await page.locator('#finalize').isEnabled(),true);
  const subtitle=files.find(file=>file.type==='subtitles');assert.equal(puts.filter(put=>put.file===subtitle.fileName&&put.part===1).length,1,'First stored part must not be uploaded twice');
  const stored=await page.evaluate(()=>JSON.stringify({...localStorage}));assert.equal(stored.includes(accessToken),false);assert.equal(/uploadUrl|X-Amz-|refreshToken/.test(stored),false);
  await page.locator('#finalize').click();await idle();assert.ok((await page.locator('#notice').textContent()).includes('已提交后台校验'));
  const out=path.resolve(__dirname,'../artifacts/production');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'operations-desktop.png'),fullPage:true});
  for(const width of [375,768,1280]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Page overflow '+width);}
  await page.locator('#disconnect').click();assert.equal(await page.locator('#upload').isDisabled(),true);assert.equal(await page.locator('#token').inputValue(),'');assert.deepEqual(errors,[]);
  const result={scope:'actual operations webpage / HTTP / PostgreSQL / MinIO; isolated admin session; no real approvals or publication',hash:'bounded SHA-256',expiredUpload:'resumed',storedPart:'not-reuploaded',wrongFile:'blocked',storageCompleteDbFailure:'recovered',credentials:'memory-only',processing:'explicit-submit',widths:[375,768,1280],errors};
  fs.writeFileSync(path.join(out,'operations-test.json'),JSON.stringify(result,null,2)+'\n');console.log('operations.browser.passed '+JSON.stringify(result));return{batchId};
 }finally{await page.unrouteAll({behavior:'wait'});await browser.close();}
};
