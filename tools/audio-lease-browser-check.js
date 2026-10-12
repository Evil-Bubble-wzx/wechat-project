const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto')
let browser,server
;(async()=>{
 const audioFile='preview/audio/peter-rabbit-librivox.mp3',size=fs.statSync(audioFile).size,sha=crypto.createHash('sha256').update(fs.readFileSync(audioFile)).digest('hex')
 const requests={expired:0,fresh:0,range:0}
 server=http.createServer((req,res)=>{
  const headers={'Content-Type':'audio/mpeg','Access-Control-Allow-Origin':'*','Accept-Ranges':'bytes','Cache-Control':'no-store'}
  if(req.url.startsWith('/old.mp3')){requests.expired++;res.writeHead(403,headers);res.end();return}
  if(!req.url.startsWith('/new.mp3')){res.writeHead(404);res.end();return}
  requests.fresh++
  const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||''),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),size-1):size-1
  if(start>end||start>=size){res.writeHead(416);res.end();return}
  if(range)requests.range++
  res.writeHead(range?206:200,{...headers,'Content-Length':end-start+1,...(range?{'Content-Range':'bytes '+start+'-'+end+'/'+size}:{})})
  fs.createReadStream(audioFile,{start,end}).pipe(res)
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base='http://127.0.0.1:'+server.address().port
 const manifest=suffix=>{
  const assets=['audio','cover','metadata','quiz','subtitles','text','vocabulary'].map(type=>({type,assetId:'test-'+type,url:base+'/'+(type==='audio'?suffix+'.mp3':type),expiresAt:new Date(Date.now()+600000).toISOString(),mimeType:type==='audio'?'audio/mpeg':type==='cover'?'image/png':'application/json',sizeBytes:type==='audio'?size:100,sha256:type==='audio'?sha:crypto.createHash('sha256').update(type).digest('hex')}))
  return{workId:'lease-book',pieceId:'lease-piece',contentVersion:1,quizVersion:1,durationMs:322026,assets,manifestSha256:crypto.createHash('sha256').update(JSON.stringify(assets.map(({type,sha256,sizeBytes})=>({type,sha256,sizeBytes})))).digest('hex')}
 }
 const old=manifest('old'),fresh=manifest('new')
 browser=await chromium.launch({headless:true,channel:'msedge'})
 const page=await browser.newPage()
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.route('**/bundle.js',async route=>{
  const response=await route.fetch(),body=(await response.text()).replace('window.Tingyue=load("ui/controller")','window.LeaseTest={player:load("modules/listen-read/player"),host:load("services/host"),lease:load("modules/listen-read/audio-lease")};window.Tingyue=load("ui/controller")')
  await route.fulfill({response,body})
 })
 await page.goto('http://127.0.0.1:4173/#home');await page.waitForFunction(()=>window.currentPage&&window.LeaseTest)
 await page.evaluate(({old,fresh})=>{
  const {player,host,lease}=LeaseTest
  host.setAccountScope('lease-account')
  host.write({progress:{'lease-piece':{schemaVersion:2,contentVersion:1,audioKey:'lease-piece|v1',duration:322.026,checkpointSeconds:30,listenedRanges:[[0,30]]}}})
  window.leaseApiCalls=0
  const getAudio=wx.getBackgroundAudioManager;wx.getBackgroundAudioManager=()=>{const manager=getAudio();previewAudio.crossOrigin='anonymous';return manager}
  player._setSourceResolverForTests(lease.createAudioLeaseResolver({host,api:{currentUser:()=>({userId:'lease-account'}),isAuthenticated:()=>true,getManifest:async()=>{leaseApiCalls++;return fresh}}}))
  const book={id:'lease-book',workId:'lease-book',pieceId:'lease-piece',contentVersion:1,title:'Local audio lease test',duration:322.026,localAudio:old.assets[0].url,remoteManifest:old,audioAccountScope:'lease-account'}
  window.leaseEvents=[];player.subscribe(s=>leaseEvents.push({status:s.status,position:s.position,reason:s.pauseReason,error:s.error,renewing:s.sourceRenewing}));player.selectTrack(book);player.setRate(1.25);player.setLoop(true);player.playTrack(book)
 },{old,fresh})
 await page.waitForFunction(()=>window.previewAudio&&!previewAudio.paused&&previewAudio.currentSrc.includes('/new.mp3')&&previewAudio.currentTime>30.3,{},{timeout:20000}).catch(async error=>{console.error(JSON.stringify({requests,events:await page.evaluate(()=>leaseEvents),audio:await page.evaluate(()=>({time:previewAudio.currentTime,paused:previewAudio.paused,error:previewAudio.error?.code,ready:previewAudio.readyState,calls:leaseApiCalls}))}));throw error})
 await page.evaluate(async()=>{
  window.leaseContext=new AudioContext();const source=leaseContext.createMediaElementSource(previewAudio);window.leaseAnalyser=leaseContext.createAnalyser();source.connect(leaseAnalyser);leaseAnalyser.connect(leaseContext.destination);await leaseContext.resume()
 })
 await page.waitForFunction(()=>{const bins=new Float32Array(leaseAnalyser.fftSize);leaseAnalyser.getFloatTimeDomainData(bins);return bins.some(value=>Math.abs(value)>.001)},{},{timeout:10000})
 const result=await page.evaluate(()=>{LeaseTest.player.pause();const s=LeaseTest.player.snapshot();return{position:s.position,checkpoint:s.checkpointPosition,rate:s.rate,loop:s.loop,apiCalls:leaseApiCalls,coverage:s.listenedRanges,status:s.status}})
 assert.equal(result.apiCalls,1);assert.equal(result.rate,1.25);assert.equal(result.loop,true);assert.equal(result.status,'paused')
 assert.ok(result.position>30&&result.position<45);assert.ok(result.checkpoint>=30);assert.ok(result.coverage.length===1&&result.coverage[0][0]===0&&result.coverage[0][1]<45)
 assert.ok(requests.expired>0&&requests.fresh>0&&requests.range>0);assert.deepEqual(errors,[])
 const evidence={test:'audio-lease-browser',scope:'local HTTP fixture and actual frontend/Edge audio; manifest API is a test adapter',bytes:size,sha256:sha,expiredHttp403:'PASS',freshHttp206:'PASS',realDecodedSamples:'PASS',cursor:'PASS',rate:'PASS',loop:'PASS',requests,result,errors}
 fs.mkdirSync('artifacts/production',{recursive:true});fs.writeFileSync('artifacts/production/audio-lease-test.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve))})
