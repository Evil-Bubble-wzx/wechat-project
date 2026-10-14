const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createGateway}=require('../tools/iphone-test-gateway.cjs');
test('iPhone gateway preserves real codes, rejects stub/admin/commerce and leases only approved assets',async()=>{
 const key='a'.repeat(64),codes=[];let badAsset=false;
 const upstream=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/session/wechat'){codes.push(JSON.parse(text).code);return res.end(JSON.stringify({accessToken:'qa-access',refreshToken:'qa-refresh',accessTokenExpiresAt:new Date(Date.now()+60000).toISOString(),refreshTokenExpiresAt:new Date(Date.now()+60000).toISOString()}));}
  if(req.url==='/api/v1/pieces/peter-rabbit-01/manifest')return res.end(JSON.stringify({assets:[{url:badAsset?'http://127.0.0.1:59000/tingyue-incoming/private':'http://127.0.0.1:59000/tingyue-published/device-fixture/peter-rabbit-01/v2/audio?signature=qa',expiresAt:new Date(Date.now()+60000).toISOString()}]}));
  res.end(JSON.stringify({items:[{workId:'peter-rabbit'},{workId:'other'}]}));
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const gateway=createGateway({key,apiRoot:'http://127.0.0.1:'+upstream.address().port,publicOrigin:()=> 'https://qa-example.trycloudflare.com'});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 const root='http://127.0.0.1:'+gateway.address().port;
 const call=(p,{body,token='qa-access',testKey=key,method=body?'POST':'GET'}={})=>fetch(root+p,{method,headers:{'x-device-test-key':testKey,authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
  assert.equal((await call('/api/v1/me',{testKey:''})).status,401);
  assert.equal((await call('/api/v1/admin/import-groups')).status,404);
  assert.equal((await call('/api/v1/me/orders')).status,404);
  assert.equal((await call('/api/v1/session/wechat',{body:{code:'test:fake'}})).status,400);
  assert.equal((await call('/api/v1/session/wechat',{body:{code:'real-wx-one-time-code'}})).status,200);assert.deepEqual(codes,['real-wx-one-time-code']);
  assert.equal((await call('/api/v1/me',{token:'foreign'})).status,401);
  assert.deepEqual((await (await call('/api/v1/works')).json()).items,[{workId:'peter-rabbit'}]);
  const manifest=await (await call('/api/v1/pieces/peter-rabbit-01/manifest')).json();assert.match(manifest.assets[0].url,/^https:\/\/qa-example.trycloudflare.com\/assets\/[a-f0-9]{48}$/);assert.ok(!manifest.assets[0].url.includes('signature'));
  badAsset=true;assert.equal((await call('/api/v1/pieces/peter-rabbit-01/manifest')).status,502);
  assert.equal((await call('/assets/unknown')).status,404);
 }finally{await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>upstream.close(r))]);}
});
