const fs=require('node:fs')
const path=require('node:path')
const {build,buildRoot,repoRoot}=require('./build-miniapp')

const forbiddenPages=['pages/loans/index','pages/coupons/index','pages/invite/index']
const forbiddenFiles=['pages/loans/','pages/coupons/','pages/invite/','modules/account/','modules/physical-loan/','modules/promotion/','quiz/assets/','modules/listen-read/legacy-cues-data.js','modules/listen-read/legacy-vocab-data.js','modules/listen-read/legacy-quiz-data.js']
const forbiddenText=[
  ['fixed demo verification code','123456'],
  ['Demo storage key','tingyue.demo.v1'],
  ['development mode key','tingyue.dev.mode'],
  ['Demo login dependency','modules/account/session'],
  ['physical-loan dependency','modules/physical-loan'],
  ['Demo promotion dependency','modules/promotion/demo'],
  ['Demo login action','demoLogin'],
  ['Demo invitation action','claimInviteReward'],
  ['Demo reservation action','openReserve'],
  ['Demo purchase action','openPurchase']
]

function auditProduction(target){
  const manifest=JSON.parse(fs.readFileSync(path.join(target,'build-manifest.json'),'utf8'))
  const names=manifest.files.map(item=>item.path)
  for(const prefix of forbiddenFiles)if(names.some(name=>name===prefix.slice(0,-1)||name.startsWith(prefix)))throw new Error('Forbidden production path: '+prefix)
  const app=JSON.parse(fs.readFileSync(path.join(target,'app.json'),'utf8'))
  for(const page of forbiddenPages)if(app.pages.includes(page))throw new Error('Forbidden production route: '+page)
  const catalog=JSON.parse(fs.readFileSync(path.join(target,'modules/catalog/catalog.json'),'utf8'))
  if(catalog.length!==1||catalog[0].id!=='peter-rabbit')throw new Error('Production catalog contains non-Peter content')
  for(const entry of manifest.files.filter(item=>/\.(?:js|json|wxml|wxss)$/.test(item.path))){
    const text=fs.readFileSync(path.join(target,entry.path),'utf8')
    if(/@(?:demo|production)-(?:start|end)/.test(text))throw new Error('Build marker leaked into '+entry.path)
    for(const [label,token] of forbiddenText)if(text.includes(token))throw new Error(label+' leaked into '+entry.path)
    if(entry.path.endsWith('.js'))for(const match of text.matchAll(/require\(['"]([^'"]+)['"]\)/g))if(match[1].startsWith('.')){
      const resolved=path.resolve(path.dirname(path.join(target,entry.path)),match[1])+'.js'
      if(!fs.existsSync(resolved))throw new Error('Missing production dependency '+match[1]+' from '+entry.path)
    }
  }
  return manifest
}

function auditDemo(target){
  const manifest=JSON.parse(fs.readFileSync(path.join(target,'build-manifest.json'),'utf8'))
  const app=JSON.parse(fs.readFileSync(path.join(target,'app.json'),'utf8'))
  for(const page of forbiddenPages)if(!app.pages.includes(page))throw new Error('Demo route missing: '+page)
  const screen=fs.readFileSync(path.join(target,'ui/screen.wxml'),'utf8')
  if(!screen.includes('123456')||!screen.includes('DEMO'))throw new Error('Demo identity was not preserved')
  return manifest
}

function run(){
  const production=build('production'),demo=build('demo')
  const productionManifest=auditProduction(production.target),demoManifest=auditDemo(demo.target)
  const evidence={schemaVersion:1,production:{fileCount:productionManifest.fileCount,totalBytes:productionManifest.totalBytes,treeSha256:productionManifest.treeSha256},demo:{fileCount:demoManifest.fileCount,totalBytes:demoManifest.totalBytes,treeSha256:demoManifest.treeSha256},checks:{productionForbiddenPaths:true,productionForbiddenText:true,productionDependencyClosure:true,productionPeterOnly:true,demoFeaturesPreserved:true}}
  const evidenceDir=path.join(repoRoot,'artifacts/build')
  fs.mkdirSync(evidenceDir,{recursive:true})
  fs.writeFileSync(path.join(evidenceDir,'X-05-release-audit.json'),JSON.stringify(evidence,null,2)+'\n')
  return evidence
}

if(require.main===module){try{console.log(JSON.stringify(run(),null,2))}catch(error){console.error(error.message);process.exitCode=1}}
module.exports={forbiddenPages,forbiddenFiles,forbiddenText,auditProduction,auditDemo,run}
