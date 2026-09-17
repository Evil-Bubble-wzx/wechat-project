const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs')
let browser
;(async()=>{
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:390,height:844}})
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
 await page.goto('http://127.0.0.1:4173/#login');await page.waitForSelector('.login-button')
 await page.locator('.login-button').click();assert.ok((await page.locator('#toast').textContent()).includes('请先'))
 await page.locator('[data-action="loginMethod"][data-id="phone"]').click();await page.getByPlaceholder('请输入手机号').fill('13800000000');await page.locator('[data-action="sendCode"]').click();await page.getByPlaceholder('短信验证码').fill('123456');await page.locator('.checkbox').click();await page.locator('.login-button').click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('tingyue.demo.v1')).user)
 async function go(route,selector){await page.goto('http://127.0.0.1:4173/#'+route);await page.waitForSelector(selector)}
 await go('home','.home-book');assert.deepEqual(await page.locator('.bottom-nav .tab>span').allTextContents(),['Home','Recent','Me']);assert.equal(await page.locator('.home-book').count(),6);assert.equal(await page.getByText('发现下一本喜欢').count(),0)
 const meta=await page.locator('.home-book').first().textContent();for(const label of ['By','Series','Lv','No.','Words','F/NF','Pages'])assert.ok(meta.includes(label))
 const tabY=(await page.locator('.bottom-nav').boundingBox()).y;await page.locator('#device').evaluate(el=>el.scrollTop=500);assert.equal((await page.locator('.bottom-nav').boundingBox()).y,tabY);await page.locator('#device').evaluate(el=>el.scrollTop=0)
 await page.locator('.bottom-nav [data-page="recent"]').click();await page.waitForSelector('.heading-caption');assert.equal(await page.locator('.bottom-nav .tab').count(),3)
 await go('library','.library-card');assert.equal(await page.locator('.bottom-nav').count(),0);await page.getByPlaceholder('Title / Series / Author / No.').fill('garden');assert.equal(await page.locator('.library-card').count(),1);await page.getByPlaceholder('Title / Series / Author / No.').fill('不存在的书');assert.equal(await page.locator('.library-card').count(),0);assert.ok(await page.locator('.empty').isVisible())
 await go('detail','.favorite');await page.locator('.favorite').click();assert.ok((await page.locator('.favorite').textContent()).includes('Saved'));await page.locator('[data-action="openReserve"]').click();await page.locator('[data-action="confirmReserve"]').click();await page.waitForSelector('.loan-card');assert.equal(await page.locator('.loan-card').count(),1)
 await go('detail','.favorite');await page.locator('[data-action="openReserve"]').click();await page.locator('[data-action="confirmReserve"]').click();assert.ok((await page.locator('#toast').textContent()).includes('已经'));await page.locator('.sheet-close').click()
 await go('loans','.loan-card');await page.locator('[data-action="cancelLoan"]').click();assert.ok((await page.locator('.loan-card').textContent()).includes('已取消'))
 await go('quiz','.answer');for(const answer of [0,1,2,1,1]){await page.locator('.answer').nth(answer).click();await page.locator('[data-action="nextQuestion"]').click()}assert.ok((await page.locator('.result-big').textContent()).includes('100'))
 await go('report','.result-row');assert.ok((await page.locator('.result-score').textContent()).includes('100'))
await go('player?id=garden','.play-button');await page.locator('.play-button').click();assert.ok((await page.locator('.sheet-title').textContent()).includes('声音'));await page.locator('.sheet-close').click();await page.locator('.subtitle-toggle').click();await page.locator('.word-link').click();await page.locator('[data-action="saveWord"]').click();await page.locator('[data-action="speed"]').click();assert.ok((await page.locator('.speed').textContent()).includes('1.25'))
 await go('me','.member-card');await page.locator('[data-sheet="words"]').click();assert.ok((await page.locator('.sheet').textContent()).includes('garden'));await page.locator('.sheet-close').click();await page.locator('[data-sheet="favorites"]').click();assert.equal(await page.locator('.queue-row').count(),1)
 await page.reload();await page.waitForSelector('.member-card');assert.ok((await page.locator('.member-name').textContent()).includes('小小阅读家'))
 for(const width of [320,390,430]){await page.setViewportSize({width,height:844});for(const route of ['home','library','loans','me','detail','player','recent','report','ranking','login','quiz']){await go(route,'.app');assert.ok(await page.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth+1),route+' horizontal overflow at '+width)}}
 await page.setViewportSize({width:390,height:844});for(const route of ['login','library','loans','me','quiz','report']){await go(route,'.app');await page.screenshot({path:'artifacts/'+route+'-mobile.png'})}
 assert.deepEqual(errors,[]);console.log('PASS: phone login, consent, search, empty state, favorites, reserve/duplicate/cancel, quiz scoring/report persistence, audio state, wordbook, rate, and all 11 routes at 320/390/430px. No console errors.')
 await browser.close()
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1})
