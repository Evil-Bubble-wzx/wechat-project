const fs = require('node:fs');
const path = require('node:path');
const { build, manifest, repoRoot } = require('./build-miniapp.js');
const apiBase = process.argv[2] || 'http://127.0.0.1:4181';
const audioUrl = process.argv[3];
const targetAppId = process.argv[4];
if (targetAppId && !/^wx[a-f0-9]{16}$/.test(targetAppId)) throw new Error('Invalid target AppID');
if (apiBase !== 'http://127.0.0.1:4181' && !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(apiBase)) throw new Error('Expected the authorized test gateway URL');
if (audioUrl && !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/peter-rabbit\.mp3$/.test(audioUrl)) throw new Error('Expected the single-audio test URL');
const { accounts } = JSON.parse(fs.readFileSync(path.join(repoRoot, '.cache/device-local/gateway.json')));
for (const account of accounts) {
  if (!['primary', 'isolation'].includes(account.name)) throw new Error('Unexpected account');
  const project = path.join(repoRoot, `build/device-api-${account.name}`);
  const target = path.join(project, 'miniprogram');
  build('production', target);
  if (audioUrl) {
    const catalogFile = path.join(target, 'modules/catalog/catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogFile));
    catalog[0].audioUrl = audioUrl;
    fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
    fs.writeFileSync(path.join(target, 'modules/catalog/catalog-data.js'), 'module.exports = ' + JSON.stringify(catalog) + '\n');
  }
  const privateConfig = { apiRoot: apiBase + '/api/v1', key: account.key, stubLoginCode: `test:${account.identity}` };
  fs.writeFileSync(path.join(target, 'config/device-test.js'), 'module.exports = ' + JSON.stringify(privateConfig) + '\n');
  const apiFile = path.join(target, 'services/api.js');
  let api = fs.readFileSync(apiFile, 'utf8');
  const configLine = 'const configuration = options.configuration || apiConfig.current(runtime)';
  const transportLine = "const transport = options.transport || (runtime && typeof runtime.request === 'function' ? createWxTransport(runtime) : null)";
  if (!api.includes(configLine) || !api.includes(transportLine)) throw new Error('Client adapter changed; review preview patch');
  api = api.replace(configLine, "const privateTest = require('../config/device-test'); const baseConfiguration = options.configuration || apiConfig.current(runtime); const configuration = baseConfiguration.development ? Object.assign({}, baseConfiguration, {apiRoot:privateTest.apiRoot, enabled:true, stubLoginCode:privateTest.stubLoginCode}) : Object.assign({}, baseConfiguration, {enabled:false})");
  api = api.replace(transportLine, "const originalTransport = options.transport || (runtime && typeof runtime.request === 'function' ? createWxTransport(runtime) : null); const transport = originalTransport && (request => originalTransport(Object.assign({}, request, {headers:Object.assign({}, request.headers, {'X-Device-Test-Key':privateTest.key})})))");
  fs.writeFileSync(apiFile, api);
  const controllerFile = path.join(target, 'ui/controller.js');
  let controller = fs.readFileSync(controllerFile, 'utf8');
  for (const marker of ['openLocalImport() {', 'async submitLocalImport() {']) {
    if (!controller.includes(marker)) throw new Error('Import handler changed; review private preview patch');
    controller = controller.replace(marker, marker + "host.toast('本轮测试仅同步新数据，历史导入暂时关闭');return;");
  }
  const loginError = "catch(_){host.toast('微信登录失败，请稍后重试')}";
  if (!controller.includes(loginError)) throw new Error('Login error handler changed; review diagnostic patch');
  controller = controller.replace(loginError, "catch(error){const message=String(error?.cause?.errMsg||error?.errMsg||'');const label=/domain|域名/i.test(message)?'域名限制':/ssl|tls|certificate/i.test(message)?'证书连接':({network:'网络失败',timeout:'连接超时',unauthorized:'凭据拒绝',contract:'响应格式',disabled:'配置未启用'})[error?.kind]||'服务失败';host.toast('测试登录：'+label)}");
  fs.writeFileSync(controllerFile, controller);
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'project.config.json')));
  if (targetAppId) config.appid = targetAppId;
  Object.assign(config, { miniprogramRoot: 'miniprogram/', projectname: `听阅-本机接口-${account.name}`, description: 'Private local API test package. Not for release or distribution.' });
  fs.writeFileSync(path.join(project, 'project.config.json'), JSON.stringify(config, null, 2));
  const result = manifest(target, 'production');
  fs.writeFileSync(path.join(target, 'build-manifest.json'), JSON.stringify(result, null, 2));
  console.log(`${account.name}: ${result.fileCount} files; local-only private package generated`);
}
