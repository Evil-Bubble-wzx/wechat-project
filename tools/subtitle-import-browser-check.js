const {chromium}=require('playwright'),assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path')
module.exports=async function subtitleBrowser(backendAddress,workId,format){
 const root=path.resolve(__dirname,'..'),child=cp.spawn(process.execPath,['tools/preview-server.js','--mini-root=build/production-miniprogram'],{cwd:root,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']})
 let browser,page,closing=false
 const errors=[],requests=[]
 const safeError=value=>String(value).replace(/https?:\/\/[^\s]+/g,'[URL omitted]')
 try{
  const preview=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Preview startup timeout')),10000)
   child.stdout.on('data',bytes=>{output+=bytes;const match=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(match&&match[1]!=='0'){clearTimeout(timer);resolve(match[0])}})
   child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('Preview exited'))})})
  browser=await chromium.launch({headless:true,channel:'msedge'})
  page=await browser.newPage({viewport:{width:390,height:844}})
  page.on('pageerror',e=>errors.push(safeError(e.message)));page.on('console',m=>{if(m.type()==='error')errors.push(safeError(m.text()))})
  await page.route('**/api/v1/**',async route=>{
   try{
    const url=new URL(route.request().url()),response=await route.fetch({url:backendAddress+url.pathname+url.search})
    requests.push({kind:'api',method:route.request().method(),path:url.pathname,status:response.status()})
    await route.fulfill({response})
   }catch(_){if(!closing)errors.push('API relay failed');await route.abort().catch(()=>{})}
  })
  // The preview's origin is not a production CDN. Relay unchanged real MinIO bytes with a test CORS bridge.
  await page.route('http://127.0.0.1:9000/**',async route=>{
   try{
    assert.equal(route.request().headers().authorization,undefined,'Resource downloads must not include API credentials')
    const response=await route.fetch()
    requests.push({kind:'asset',status:response.status()})
    await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':'*'}})
   }catch(_){if(!closing)errors.push('Resource relay failed');await route.abort().catch(()=>{})}
  })
  await page.route('**/bundle.js',async route=>{const response=await route.fetch(),body=(await response.text()).replace('window.Tingyue=load("ui/controller")','window.SubtitleBrowser={api:load("services/api")};window.Tingyue=load("ui/controller")');await route.fulfill({response,body})})
  await page.goto(preview+'/#home');await page.waitForFunction(()=>window.SubtitleBrowser)
  await page.evaluate(async()=>{
   const {api}=SubtitleBrowser;wx.login=({success})=>success({code:'test:subtitle-browser-platform'})
   const client=api.createBackendApi({configuration:{enabled:true,apiRoot:location.origin+'/api/v1',contractVersion:'api-contract-v2.6.0',development:true,stubLoginCode:'test:subtitle-browser-fixture'},runtime:wx,maxRetries:0,
    transport:async request=>{const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body)});return{statusCode:response.status,data:await response.json(),headers:Object.fromEntries(response.headers)}}})
   for(const key of Object.keys(client))if(typeof client[key]==='function'&&key in api)api[key]=client[key]
   await api.loginWechat();location.hash='library'
  })
  await page.waitForFunction(id=>currentPage.data.route==='library'&&currentPage.data.catalogStatus==='ready'&&currentPage.data.shown.some(b=>b.id===id),workId)
  await page.locator('[data-action="openBook"][data-id="'+workId+'"]').click()
  await page.waitForFunction(()=>currentPage.data.route==='detail'&&currentPage.data.remoteContentStatus==='ready')
  await page.locator('[data-action="startChapter"]').first().click()
  await page.waitForFunction(()=>currentPage.data.route==='player'&&currentPage.data.remoteContentStatus==='ready'&&currentPage.data.subtitleRows.some(r=>r.text?.includes('import:')))
  const state=await page.evaluate(()=>({version:currentPage.data.book.contentVersion,cueCount:currentPage.cuesForBook().length,
   first:currentPage.cuesForBook()[0].text,mime:currentPage.remoteBundle&&currentPage.data.book.remoteManifest.assets.find(a=>a.type==='subtitles').mimeType,
   guessed:currentPage.data.subtitleRows.some(r=>(r.tokens||[]).some(t=>t.vocabKey)),playing:currentPage.data.playing}))
  assert.ok(state.first.startsWith(format.toUpperCase()+' import:'));assert.equal(state.mime,'application/json');assert.equal(state.guessed,false);assert.equal(state.playing,false)
  assert.ok((await page.locator('.reader-subtitles').textContent()).includes('café & tea.'))
  assert.equal(await page.locator('.reader-word').count(),0)
  fs.mkdirSync(path.join(root,'artifacts/production'),{recursive:true})
  for(const width of [320,390,430]){
   await page.setViewportSize({width,height:844});assert.ok(await page.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Subtitle page overflow '+width)
   if(width===390)await page.screenshot({path:path.join(root,'artifacts/production/subtitle-'+format+'-mobile.png')})
  }
  await page.locator('[data-action="stepSentence"][data-step="1"]').click()
  await page.waitForFunction(()=>currentPage.data.subtitleCurrent===1)
  assert.equal(await page.evaluate(()=>currentPage.data.playing),false)
  assert.deepEqual(errors,[]);assert.ok(requests.filter(r=>r.kind==='asset').length>=4);assert.ok(requests.every(r=>r.status<400))
  const result={scope:'actual frontend/HTTP/Fastify/PostgreSQL/Worker/MinIO bytes; test identity, preview navigation and CORS bridge',format,normalizedMime:state.mime,cueCount:state.cueCount,sourceText:'preserved',contextualWords:'not-inferred',navigation:'library-detail-player',sentenceStep:'PASS',widths:[320,390,430],errors}
  fs.writeFileSync(path.join(root,'artifacts/production/subtitle-'+format+'-test.json'),JSON.stringify(result,null,2)+'\n')
  console.log('subtitle.import.browser.passed '+JSON.stringify(result))
 }catch(error){console.error('subtitle.browser.requests '+JSON.stringify(requests));throw error}
 finally{closing=true;if(page)await page.unrouteAll({behavior:'wait'});if(browser)await browser.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,2000)})}
}
