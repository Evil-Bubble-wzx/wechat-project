const fs=require('node:fs')
const path=require('node:path')
const {build,buildRoot}=require('./build-miniapp')
const {auditProduction,auditDemo}=require('./release-audit')

function verify(){
  const first={production:build('production'),demo:build('demo')}
  auditProduction(first.production.target);auditDemo(first.demo.target)
  try{
    const second={production:build('production',path.join(buildRoot,'verify-production')),demo:build('demo',path.join(buildRoot,'verify-demo'))}
    auditProduction(second.production.target);auditDemo(second.demo.target)
    for(const mode of ['production','demo'])if(first[mode].manifest.treeSha256!==second[mode].manifest.treeSha256)throw new Error(mode+' build is not reproducible')
    return {production:first.production.manifest.treeSha256,demo:first.demo.manifest.treeSha256,reproducible:true}
  }finally{
    for(const name of ['verify-production','verify-demo'])fs.rmSync(path.join(buildRoot,name),{recursive:true,force:true})
  }
}
if(require.main===module){try{console.log(JSON.stringify(verify(),null,2))}catch(error){console.error(error.message);process.exitCode=1}}
module.exports={verify}
