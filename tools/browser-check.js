const { spawn, spawnSync } = require('node:child_process')

const root = require('node:path').resolve(__dirname,'..')
const wait = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds))

async function waitForServer(child) {
  for (let attempt=0;attempt<60;attempt++) {
    if (child.exitCode !== null) throw new Error('Preview server exited before becoming ready')
    try { const response=await fetch('http://127.0.0.1:4173/');if(response.ok)return } catch (_) {}
    await wait(100)
  }
  throw new Error('Timed out waiting for preview server')
}

function run(script) {
  const result=spawnSync(process.execPath,[script],{cwd:root,stdio:'inherit'})
  if(result.status!==0)throw new Error(script+' failed with exit code '+result.status)
}

async function withPreview(mode,miniRoot,scripts) {
  const args=['tools/preview-server.js','--mini-root='+miniRoot]
  if(mode==='demo')args.push('--demo')
  const child=spawn(process.execPath,args,{cwd:root,stdio:['ignore','inherit','inherit']})
  try { await waitForServer(child);for(const script of scripts)run(script) }
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
