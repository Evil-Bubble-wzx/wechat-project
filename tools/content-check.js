const fs=require('node:fs'),path=require('node:path')
function validate(books) {
 if(!Array.isArray(books))throw new Error('内容必须是书目数组')
 const ids=new Set()
 for(const [i,b] of books.entries()){
  const label='第 '+(i+1)+' 本书 '+(b.id||'')
  for(const k of ['id','title','zh','author','series','level','cover','number','desc','time','category'])if(typeof b[k]!=='string'||!b[k].trim())throw new Error(label+' 缺少 '+k)
  if(ids.has(b.id))throw new Error(label+' ID 重复');ids.add(b.id)
  for(const k of ['words','pages','duration','stock'])if(!Number.isFinite(b[k])||b[k]<0)throw new Error(label+' '+k+' 必须为非负数字')
  if(b.duration===0)throw new Error(label+' duration 必须大于零')
  if(!['fiction','nonfiction'].includes(b.category))throw new Error(label+' category 无效')
  if(b.audioUrl&&!/^https:\/\//.test(b.audioUrl))throw new Error(label+' audioUrl 必须使用 HTTPS')
  if(b.cover.startsWith('/assets/')&&!fs.existsSync(path.join(__dirname,'../miniprogram',b.cover)))throw new Error(label+' 封面文件不存在')
 }
 return books.length
}
if(require.main===module){try{const file=process.argv.slice(2).find(a=>!a.startsWith('--'))||path.join(__dirname,'../miniprogram/modules/catalog/catalog.json');const books=JSON.parse(fs.readFileSync(file,'utf8'));console.log('内容校验通过：'+validate(books)+' 本。');if(process.argv.includes('--build')){fs.writeFileSync(path.join(__dirname,'../miniprogram/modules/catalog/catalog-data.js'),'// Generated from catalog.json with npm run content:build. Do not edit by hand.\nmodule.exports = '+JSON.stringify(books,null,2)+'\n');console.log('已生成原生小程序内容模块。')}}catch(e){console.error(e.message);process.exitCode=1}}
module.exports={validate}
