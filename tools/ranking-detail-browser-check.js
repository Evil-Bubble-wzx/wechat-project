const {chromium}=require('playwright'),assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path')
module.exports=async function rankingBrowser(backendAddress){
 const root=path.resolve(__dirname,'..'),child=cp.spawn(process.execPath,['tools/preview-server.js','--mini-root=build/production-miniprogram'],{cwd:root,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']})
 let browser
 try{
  const preview=await new Promise((resolve,reject)=>{
   let output='';const timer=setTimeout(()=>reject(Error('Preview startup timeout')),10000)
   child.stdout.on('data',bytes=>{output+=bytes;const match=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(match&&match[1]!=='0'){clearTimeout(timer);resolve(match[0])}})
   child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('Preview exited'))})
  })
  browser=await chromium.launch({headless:true,channel:'msedge'})
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],responses=[],failedResponses=[]
  page.on('response',response=>{if(response.status()>=400)failedResponses.push({status:response.status(),path:new URL(response.url()).pathname})})
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text())})
  await page.route('**/api/v1/**',async route=>{
   const url=new URL(route.request().url())
   const response=await route.fetch({url:backendAddress+url.pathname+url.search})
   if(url.pathname.endsWith('/quiz-analysis'))responses.push({status:response.status(),query:url.searchParams.get('query')||'',sort:url.searchParams.get('sort'),snapshotId:url.searchParams.get('snapshotId')})
   await route.fulfill({response})
  })
  await page.route('**/bundle.js',async route=>{
   const response=await route.fetch(),body=(await response.text()).replace('window.Tingyue=load("ui/controller")','window.RankingBrowser={api:load("services/api"),host:load("services/host")};window.Tingyue=load("ui/controller")')
   await route.fulfill({response,body})
  })
  await page.goto(preview+'/#home');await page.waitForFunction(()=>window.currentPage&&window.RankingBrowser)
  await page.evaluate(async()=>{
   const {api}=RankingBrowser
   wx.login=({success})=>success({code:'test:browser-platform-code'})
   const client=api.createBackendApi({configuration:{enabled:true,apiRoot:location.origin+'/api/v1',contractVersion:'api-contract-v2.4.0',development:true,stubLoginCode:'test:ranking-browser-fixture'},runtime:wx,maxRetries:0,
    transport:async request=>{const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body)});return{statusCode:response.status,data:await response.json(),headers:Object.fromEntries(response.headers)}}})
   for(const key of Object.keys(client))if(typeof client[key]==='function'&&key in api)api[key]=client[key]
   await api.loginWechat();location.hash='ranking'
  })
  await page.waitForFunction(()=>currentPage.data.route==='ranking'&&currentPage.data.rankingStatus==='choose_campus')
  await page.locator('select[data-action="chooseRankingCampus"]').selectOption('0')
  await page.waitForFunction(()=>currentPage.data.rankingStatus==='ready')
  const list=await page.evaluate(()=>({snapshotId:currentPage.data.rankingSnapshotId,filters:currentPage.rankingScopeFilters,first:currentPage.data.rankingItems[0].participantId}))
  await page.locator('[data-action="openRankingDetail"]').first().click()
  await page.waitForFunction(()=>currentPage.data.route==='ranking-detail'&&currentPage.data.status==='ready')
  const detail=await page.evaluate(()=>({snapshotId:currentPage.ctx.snapshotId,participantId:currentPage.ctx.participantId,rows:currentPage.data.quizzes.length,total:currentPage.data.totalMatches,stats:currentPage.data.statsRows}))
  assert.equal(detail.snapshotId,list.snapshotId);assert.equal(detail.participantId,list.first);assert.equal(detail.rows,50);assert.equal(detail.total,58)
  assert.equal(await page.locator('.analysis-stat').count(),9)
  await page.locator('[data-action="more"]').click();await page.waitForFunction(()=>currentPage.data.quizzes.length===58)
  await page.getByPlaceholder('Title / Series / Author / No.').fill('%');await page.locator('button[data-action="search"]').click();await page.waitForFunction(()=>currentPage.data.status==='ready'&&currentPage.data.totalMatches===1)
  assert.ok((await page.locator('.analysis-quiz-heading').textContent()).includes('Alpha%'))
  await page.locator('[data-action="clearSearch"]').click();await page.waitForFunction(()=>currentPage.data.status==='ready'&&currentPage.data.totalMatches===58)
  await page.locator('select[data-action="chooseSort"]').selectOption('4');await page.waitForFunction(()=>currentPage.data.status==='ready'&&currentPage.data.sortIndex===4)
  await page.locator('[data-action="toggleDirection"]').click();await page.waitForFunction(()=>currentPage.data.status==='ready'&&currentPage.data.direction==='asc')
  await page.locator('[data-action="toggleStats"]').click();assert.equal(await page.locator('.analysis-stat').count(),0)
  await page.locator('[data-action="toggleStats"]').click()
  fs.mkdirSync(path.join(root,'artifacts/production'),{recursive:true})
  await page.evaluate(()=>{document.getElementById('device').scrollTop=0;window.scrollTo(0,0)})
  for(const width of [320,390,430]){
   await page.setViewportSize({width,height:844})
   assert.ok(await page.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Detail overflow '+width)
   if(width===390)await page.screenshot({path:path.join(root,'artifacts/production/ranking-detail-mobile.png')})
  }
  assert.deepEqual(errors,[],JSON.stringify(failedResponses))
  await page.locator('.nav-left[data-action="back"]').click();await page.waitForFunction(()=>currentPage.data.route==='ranking')
  await page.waitForFunction(()=>currentPage.data.rankingStatus==='ready')
  assert.equal(await page.evaluate(()=>currentPage.data.rankingType),list.filters.periodType)
  assert.equal(await page.evaluate(()=>currentPage.rankingFilters().campusId),list.filters.campusId)
  assert.equal(await page.evaluate(()=>currentPage.rankingFilters().grade),list.filters.grade)
  assert.equal(await page.evaluate(()=>currentPage.rankingFilters().level),list.filters.level)
  const result={scope:'actual frontend and HTTP/Fastify/PostgreSQL; local browser navigation bridge and test WeChat identity',snapshot:'pinned',route:'standalone',pagination:'50+8',passedAll:'visible',search:'literal',sort:'server',back:'PASS',widths:[320,390,430],responses,errors}
  fs.writeFileSync(path.join(root,'artifacts/production/ranking-detail-test.json'),JSON.stringify(result,null,2))
  console.log('ranking.analysis.browser.passed '+JSON.stringify({route:result.route,pagination:result.pagination,search:result.search,sort:result.sort,errors}))
 }finally{if(browser)await browser.close();child.kill()}
}
