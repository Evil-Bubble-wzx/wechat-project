const fs=require('node:fs');
const path=require('node:path');
const {build,manifest,repoRoot}=require('./build-miniapp.js');
for(const account of ['primary','isolation']){
  const project=path.join(repoRoot,'build',`commerce-local-${account}`),target=path.join(project,'miniprogram');
  build('production',target);
  fs.writeFileSync(path.join(target,'config/commerce-test.js'),'module.exports = {enabled:true}\n');
  const apiFile=path.join(target,'services/api.js'),marker='const configuration = options.configuration || apiConfig.current(runtime)';
  let api=fs.readFileSync(apiFile,'utf8');if(!api.includes(marker))throw Error('Review API configuration patch');
  api=api.replace(marker,`const base=options.configuration || apiConfig.current(runtime); const configuration=base.development ? Object.assign({},base,{enabled:true,apiRoot:'http://127.0.0.1:3100/api/v1',stubLoginCode:'test:device-restricted-${account}'}) : Object.assign({},base,{enabled:false})`);
  fs.writeFileSync(apiFile,api);
  const config=JSON.parse(fs.readFileSync(path.join(repoRoot,'project.config.json')));
  config.appid='wxef246c6a495e4030';config.miniprogramRoot='miniprogram/';config.projectname=`听阅-本机模拟交易-${account}`;
  config.description='本机模拟订单验收专用；不扣款，不用于发布或手机预览';
  config.setting=Object.assign({},config.setting,{urlCheck:false});
  fs.writeFileSync(path.join(project,'project.config.json'),JSON.stringify(config,null,2));
  fs.writeFileSync(path.join(target,'build-manifest.json'),JSON.stringify(manifest(target,'production'),null,2));
  console.log('Local developer-tools build ready: '+project);
}
