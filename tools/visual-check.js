const { chromium } = require('playwright')
const fs=require('node:fs')
const baseUrl=process.env.TINGYUE_PREVIEW_URL||'http://127.0.0.1:4173'
let browser
;(async()=>{
 fs.mkdirSync('artifacts/production',{recursive:true})
 browser=await chromium.launch({headless:true,channel:'msedge'})
 const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1})
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
 await page.goto(baseUrl);await page.waitForSelector('.home-book');await page.screenshot({path:'artifacts/production/home-desktop.png',fullPage:true})
 console.log(JSON.stringify({title:await page.title(),errors,images:await page.locator('#app img').evaluateAll(els=>els.filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src))}))
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/production/home-mobile.png',fullPage:true})
 await page.locator('#device').evaluate(el=>el.scrollTop=510);await page.screenshot({path:'artifacts/production/book-list-mobile.png'});await page.locator('#device').evaluate(el=>el.scrollTop=0)
 await page.goto(baseUrl+'/#detail');await page.waitForSelector('.detail-cover');await page.screenshot({path:'artifacts/production/detail-mobile.png',fullPage:true})
 await page.goto(baseUrl+'/#player?id=peter-rabbit');await page.waitForSelector('.play-button');await page.screenshot({path:'artifacts/production/player-mobile.png',fullPage:true})
 await browser.close()
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1})
