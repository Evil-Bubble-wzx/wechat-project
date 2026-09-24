const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')

const root = require('node:path').resolve(__dirname,'..')
const wait = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds))

const freePort = () => new Promise((resolve,reject) => {
  const server=net.createServer()
  server.once('error',reject)
  server.listen(0,'127.0.0.1',()=>{const address=server.address();server.close(error=>error?reject(error):resolve(address.port))})
})

async function waitForServer(child,baseUrl) {
  for (let attempt=0;attempt<60;attempt++) {
    if (child.exitCode !== null) throw new Error('Preview server exited before becoming ready')
    try { const response=await fetch(baseUrl+'/');if(response.ok)return } catch (_) {}
    await wait(100)
  }
  throw new Error('Timed out waiting for preview server')
}

function run(script) {
  const result=spawnSync(process.execPath,[script],{cwd:root,stdio:'inherit'})
  if(result.status!==0)throw new Error(script+' failed with exit code '+result.status)
}

async function withPreview(mode,miniRoot,scripts) {
  const port=await freePort(),baseUrl='http://127.0.0.1:'+port
  const args=['tools/preview-server.js','--mini-root='+miniRoot]
  if(mode==='demo')args.push('--demo')
  const env={...process.env,PORT:String(port),TINGYUE_PREVIEW_URL:baseUrl}
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','inherit','inherit']})
  try { await waitForServer(child,baseUrl);for(const script of scripts){const result=spawnSync(process.execPath,[script],{cwd:root,env,stdio:'inherit'});if(result.status!==0)throw new Error(script+' failed with exit code '+result.status)} }
  finally { child.kill();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(2000)]) }
}

;(async()=>{
  const build=spawnSync(process.execPath,['tools/content-check.js','--build'],{cwd:root,stdio:'inherit'})
  if(build.status!==0)throw new Error('Content build failed')
  run('tools/release-audit.js')
  await withPreview('production','build/production-miniprogram',['tools/product-mode-check.js','tools/visual-check.js','tools/audio-check.js'])
  await withPreview('demo','build/demo-miniprogram',['tools/interaction-check.js'])
  console.log('PASS: production and explicit Demo browser suites completed.')
})().catch(error=>{console.error(error);process.exitCode=1})
