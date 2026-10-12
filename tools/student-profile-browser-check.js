const {chromium}=require('playwright'),assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path')
module.exports=async function profileBrowser(backendAddress,studentCode){
 const root=path.resolve(__dirname,'..'),child=cp.spawn(process.execPath,['tools/preview-server.js','--mini-root=build/production-miniprogram'],{cwd:root,env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']})
 let browser
 const requests=[],pages=[],errors=[]
 try{
  const preview=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Preview startup timeout')),10000)
   child.stdout.on('data',bytes=>{output+=bytes;const match=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(match&&match[1]!=='0'){clearTimeout(timer);resolve(match[0])}})
   child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('Preview exited'))})})
  browser=await chromium.launch({headless:true,channel:'msedge'})
  const writes=[]
  async function loginPage(code){
   const page=await browser.newPage({viewport:{width:390,height:844}});pages.push(page)
   page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
   await page.route('**/api/v1/**',async route=>{
    try{const url=new URL(route.request().url()),response=await route.fetch({url:backendAddress+url.pathname+url.search})
    requests.push({method:route.request().method(),path:url.pathname,status:response.status(),authorized:!!route.request().headers().authorization})
    if(route.request().method()==='PUT'&&url.pathname.includes('/student-profiles/'))writes.push(response.status())
    await route.fulfill({response})}catch{errors.push('api-bridge-failed');await route.abort().catch(()=>{})}
   })
   await page.route('**/bundle.js',async route=>{const response=await route.fetch(),body=(await response.text()).replace('window.Tingyue=load("ui/controller")','window.ProfileBrowser={api:load("services/api"),host:load("services/host")};window.Tingyue=load("ui/controller")');await route.fulfill({response,body})})
   await page.goto(preview+'/#home');await page.waitForFunction(()=>window.ProfileBrowser)
   await page.evaluate(async code=>{
    const {api}=ProfileBrowser;wx.login=({success})=>success({code:'test:profile-browser-platform'})
    const client=api.createBackendApi({configuration:{enabled:true,apiRoot:location.origin+'/api/v1',contractVersion:'api-contract-v2.5.0',development:true,stubLoginCode:code},runtime:wx,maxRetries:0,
     transport:async request=>{const response=await fetch(request.url,{method:request.method,headers:request.headers,body:request.body===undefined?undefined:JSON.stringify(request.body)});return{statusCode:response.status,data:await response.json(),headers:Object.fromEntries(response.headers)}}})
    for(const key of Object.keys(client))if(typeof client[key]==='function'&&key in api)api[key]=client[key]
    await api.loginWechat();location.hash='me'
   },code)
   await page.waitForFunction(()=>currentPage.data.route==='me'&&currentPage.data.studentProfileStatus==='ready')
   return page
  }
  const staff=await loginPage('test:student-profile-browser-operator')
  assert.equal(await staff.locator('[data-action="openStudentProfiles"]').count(),1)
  await staff.locator('[data-action="openStudentProfiles"]').click()
  await staff.waitForFunction(()=>currentPage.data.route==='student-profile'&&currentPage.data.canManage&&!currentPage.data.busy)
  await staff.getByPlaceholder('Student Code').fill(studentCode);await staff.locator('[data-action="lookup"]').click()
  await staff.waitForFunction(()=>currentPage.data.profile&&!currentPage.data.busy)
  await staff.locator('select[data-action="chooseCampus"]').selectOption('1')
  await staff.locator('select[data-action="chooseGrade"]').selectOption('5')
  await staff.locator('select[data-action="chooseLevel"]').selectOption('3')
  await staff.getByPlaceholder('变更依据（请勿填写联系方式等无关隐私）').fill('校方记录核验')
  await staff.locator('.profile-confirm').click();await staff.locator('[data-action="save"]').click()
  await staff.waitForFunction(()=>currentPage.data.profile?.revision==='1'&&!currentPage.data.busy)
  const saved=await staff.evaluate(()=>({campus:currentPage.data.profile.campusId,grade:currentPage.data.profile.grade,level:currentPage.data.profile.readingLevel,notice:currentPage.data.notice}))
  assert.deepEqual([saved.campus,saved.grade,saved.level],['a','4','3']);assert.ok(saved.notice.includes('下期'))
  fs.mkdirSync(path.join(root,'artifacts/production'),{recursive:true})
  await staff.evaluate(()=>{document.getElementById('device').scrollTop=0;window.scrollTo(0,0)})
  for(const width of [320,390,430]){await staff.setViewportSize({width,height:844});assert.ok(await staff.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Profile overflow '+width);if(width===390)await staff.screenshot({path:path.join(root,'artifacts/production/student-profile-mobile.png')})}
  await staff.locator('.nav-left[data-action="back"]').click();await staff.waitForFunction(()=>currentPage.data.route==='me'&&currentPage.data.studentProfileStatus==='ready')
  const learner=await loginPage('test:student-profile-browser-reader')
  assert.equal(await learner.locator('[data-action="openStudentProfiles"]').count(),0)
  assert.ok((await learner.locator('.student-profile-card').textContent()).includes('Grade 4'))
  await learner.evaluate(()=>location.hash='student-profile');await learner.waitForFunction(()=>currentPage.data.status==='forbidden')
  assert.equal(await learner.locator('.profile-search').count(),0)
  assert.equal(await learner.evaluate(()=>currentPage.data.profile),null)
  await Promise.all(pages.map(page=>page.unrouteAll({behavior:'wait'})))
  assert.deepEqual(writes,[200]);assert.deepEqual(errors,[])
  const result={scope:'actual frontend/HTTP/Fastify/PostgreSQL; test WeChat identity and preview navigation bridge',staff:'authorized-save',student:'own-profile-only',directManagementRoute:'denied',periodPolicy:'period_start',widths:[320,390,430],writes,errors}
  fs.writeFileSync(path.join(root,'artifacts/production/student-profile-test.json'),JSON.stringify(result,null,2)+'\n')
  console.log('student.profile.browser.passed '+JSON.stringify(result))
 }catch(error){console.error('profile.browser.requests '+JSON.stringify(requests));throw error}
 finally{await Promise.all(pages.map(page=>page.unrouteAll({behavior:'wait'})));if(browser)await browser.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,2000)})}
}
