const fs=require('node:fs')
const path=require('node:path')
const crypto=require('node:crypto')

const repoRoot=path.resolve(__dirname,'..')
const sourceRoot=path.join(repoRoot,'miniprogram')
const buildRoot=path.join(repoRoot,'build')
const modes=['production','demo']
const textExtensions=new Set(['.js','.json','.wxml','.wxss'])

function inside(parent,target){const base=path.resolve(parent)+path.sep;return path.resolve(target).startsWith(base)}
function removeSafe(target){if(!inside(buildRoot,target))throw new Error('Unsafe build cleanup target: '+target);fs.rmSync(target,{recursive:true,force:true})}
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)])}
function sha(buffer){return crypto.createHash('sha256').update(buffer).digest('hex')}
function normalize(file,root){return path.relative(root,file).split(path.sep).join('/')}

function stripBlocks(text,mode,file){
  for(const kind of modes){
    const keep=kind===mode
    const pairs=[
      [`/* @${kind}-start */`,`/* @${kind}-end */`],
      [`<!-- @${kind}-start -->`,`<!-- @${kind}-end -->`]
    ]
    for(const [start,end] of pairs){
      const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
      const pattern=new RegExp(escaped(start)+'[\\s\\S]*?'+escaped(end),'g')
      text=text.replace(pattern,block=>keep?block.slice(start.length,-end.length):'')
      if(text.includes(start)||text.includes(end))throw new Error('Unbalanced '+kind+' build marker in '+file)
    }
  }
  return text
}

function productionPolicy(){return `const PRODUCTION='production'\nconst PRODUCT_STORAGE_KEY='tingyue.product.v1'\nconst productionRoutes=['home','library','me','detail','player','recent','report','ranking','login','quiz','notices']\nconst productionBookIds=['peter-rabbit']\nfunction resolveMode(){return PRODUCTION}\nfunction current(){return {mode:PRODUCTION,isDemo:false,storageKey:PRODUCT_STORAGE_KEY,allowedRoutes:productionRoutes,allowedBookIds:productionBookIds,allowsRoute:route=>productionRoutes.includes(route),allowsBook:bookId=>productionBookIds.includes(bookId)}}\nmodule.exports={PRODUCTION,PRODUCT_STORAGE_KEY,productionRoutes,productionBookIds,resolveMode,current}\n`}

function manifest(target,mode){
  const files=walk(target).filter(file=>normalize(file,target)!=='build-manifest.json').sort((a,b)=>normalize(a,target).localeCompare(normalize(b,target)))
  const entries=files.map(file=>{const bytes=fs.readFileSync(file);return {path:normalize(file,target),bytes:bytes.length,sha256:sha(bytes)}})
  const digest=sha(Buffer.from(entries.map(entry=>entry.path+'\0'+entry.bytes+'\0'+entry.sha256).join('\n')))
  return {schemaVersion:1,mode,fileCount:entries.length,totalBytes:entries.reduce((sum,entry)=>sum+entry.bytes,0),treeSha256:digest,files:entries}
}

function build(mode,target=path.join(buildRoot,mode+'-miniprogram')){
  if(!modes.includes(mode))throw new Error('Mode must be production or demo')
  removeSafe(target)
  fs.mkdirSync(path.dirname(target),{recursive:true})
  fs.cpSync(sourceRoot,target,{recursive:true})
  for(const file of walk(target))if(textExtensions.has(path.extname(file))){const text=fs.readFileSync(file,'utf8');fs.writeFileSync(file,stripBlocks(text,mode,normalize(file,target)))}

  if(mode==='production'){
    const appPath=path.join(target,'app.json'),app=JSON.parse(fs.readFileSync(appPath,'utf8'))
    app.pages=app.pages.filter(page=>!['pages/loans/index','pages/coupons/index','pages/invite/index'].includes(page))
    fs.writeFileSync(appPath,JSON.stringify(app,null,2)+'\n')
    const catalogPath=path.join(target,'modules/catalog/catalog.json'),catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'))
    const peter=catalog.filter(book=>book.id==='peter-rabbit')
    if(peter.length!==1)throw new Error('Production catalog must resolve exactly one Peter Rabbit entry')
    fs.writeFileSync(catalogPath,JSON.stringify(peter,null,2)+'\n')
    fs.writeFileSync(path.join(target,'modules/catalog/catalog-data.js'),'// Generated production catalog. Do not edit.\nmodule.exports = '+JSON.stringify(peter,null,2)+'\n')
    fs.writeFileSync(path.join(target,'config/product-mode.js'),productionPolicy())
    for(const relative of ['pages/loans','pages/coupons','pages/invite','modules/account','modules/physical-loan','modules/promotion','quiz/assets'])removeSafe(path.join(target,relative))
    for(const name of ['legacy-cues-data.js','legacy-vocab-data.js','legacy-quiz-data.js'])removeSafe(path.join(target,'modules/listen-read',name))
    for(const book of catalog.filter(item=>item.id!=='peter-rabbit')){
      if(String(book.cover||'').startsWith('/assets/'))removeSafe(path.join(target,book.cover.slice(1)))
      for(const chapter of book.chapters||[])if(String(chapter.localAudio||'').startsWith('/'))removeSafe(path.join(target,chapter.localAudio.slice(1)))
    }
  }
  const result=manifest(target,mode)
  fs.writeFileSync(path.join(target,'build-manifest.json'),JSON.stringify(result,null,2)+'\n')
  return {target,manifest:result}
}

if(require.main===module){
  const mode=process.argv[2]
  try{const result=build(mode);console.log(JSON.stringify({mode,target:normalize(result.target,repoRoot),fileCount:result.manifest.fileCount,totalBytes:result.manifest.totalBytes,treeSha256:result.manifest.treeSha256},null,2))}catch(error){console.error(error.message);process.exitCode=1}
}

module.exports={repoRoot,sourceRoot,buildRoot,modes,build,manifest,stripBlocks}
