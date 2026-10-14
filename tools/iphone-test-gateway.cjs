// Temporary, keyed iPhone gateway. Never forwards admin/commerce/import routes.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {Readable}=require('node:stream');
const routes=[['POST',/^\/api\/v1\/session\/(wechat|refresh)$/],['DELETE',/^\/api\/v1\/session\/current$/],
 ['GET',/^\/api\/v1\/me(?:\/(progress(?:\/peter-rabbit-01)?|learning-score|learning-summary|quiz-history|student-profile))?$/],
 ['PUT',/^\/api\/v1\/me\/progress\/peter-rabbit-01$/],['POST',/^\/api\/v1\/me\/(words\/sync|quiz-attempts|library\/sync)$/],
 ['GET',/^\/api\/v1\/works(?:\/peter-rabbit)?$/],['GET',/^\/api\/v1\/pieces\/peter-rabbit-01\/manifest$/]];
function createGateway({key,apiRoot='http://127.0.0.1:3101',assetOrigin='http://127.0.0.1:59000',publicOrigin,ttlMs=6*3600000,expiresAt}){
 if(!/^[a-f0-9]{64}$/.test(key)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiRoot)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(assetOrigin))throw Error('Invalid localhost configuration');
 const end=expiresAt?Date.parse(expiresAt):Date.now()+ttlMs;if(!Number.isFinite(end))throw Error('Invalid gateway expiry');const assets=new Map(),access=new Map(),refresh=new Map();let minute=0,count=0;
 const deny=(res,status)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:{code:'IPHONE_TEST_GATEWAY_REJECTED'}}));};
 return http.createServer(async(req,res)=>{res.on('finish',()=>console.log(JSON.stringify({method:req.method,path:String(req.url).split('?')[0],status:res.statusCode})));try{
  const now=Date.now();if(now>end)return deny(res,410);
  for(const map of [assets,access,refresh])for(const [k,v]of map)if(v.until<=now)map.delete(k);
  if(!req.url.startsWith('/')||req.url.includes('..')||req.url.includes('\\')||req.url.startsWith('//'))return deny(res,404);
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/assets/')){
   if(!['GET','HEAD'].includes(req.method)||url.search)return deny(res,404);
   const entry=assets.get(url.pathname.slice(8));if(!entry)return deny(res,404);
   const headers={};if(req.headers.range){if(!/^bytes=\d*-\d*$/.test(req.headers.range))return deny(res,416);headers.range=req.headers.range;}
   const r=await fetch(entry.url,{method:req.method,headers,redirect:'error',signal:AbortSignal.timeout(150000)});
   const out={'Cache-Control':'no-store'};for(const n of ['content-type','content-length','content-range','accept-ranges'])if(r.headers.has(n))out[n]=r.headers.get(n);
   res.writeHead(r.status,out);if(req.method==='HEAD'||!r.body)return res.end();Readable.fromWeb(r.body).on('error',()=>res.destroy()).pipe(res);return;
  }
  const supplied=String(req.headers['x-device-test-key']||'');if(supplied.length!==key.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(key)))return deny(res,401);
  if(url.pathname.includes('%')||!routes.some(([m,p])=>m===req.method&&p.test(url.pathname)))return deny(res,404);
  const current=Math.floor(now/60000);if(current!==minute){minute=current;count=0;}if(++count>120||assets.size>200||access.size+refresh.size>100)return deny(res,429);
  const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>262144)return deny(res,413);chunks.push(c);}
  if(bytes&&!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))return deny(res,415);
  const body=bytes?JSON.parse(Buffer.concat(chunks).toString()):undefined;
  const login=url.pathname==='/api/v1/session/wechat',rotate=url.pathname==='/api/v1/session/refresh';
  const bearer=String(req.headers.authorization||'').replace(/^Bearer /,'');
  if(login){if(!body||typeof body.code!=='string'||body.code.startsWith('test:'))return deny(res,400);}
  else if(rotate){if(!refresh.has(body?.refreshToken))return deny(res,401);}
  else if(!access.has(bearer))return deny(res,401);
  const headers={};for(const n of ['authorization','content-type','idempotency-key'])if(typeof req.headers[n]==='string')headers[n]=req.headers[n];
  const r=await fetch(apiRoot+url.pathname+url.search,{method:req.method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  const data=await r.json();
  if(r.ok&&(login||rotate)){
   if(!data.accessToken||!data.refreshToken)return deny(res,502);
   access.set(data.accessToken,{until:Date.parse(data.accessTokenExpiresAt)});refresh.set(data.refreshToken,{until:Date.parse(data.refreshTokenExpiresAt)});
  }
  if(r.ok&&url.pathname==='/api/v1/works'){data.items=(data.items||[]).filter(x=>x.workId==='peter-rabbit'||x.id==='peter-rabbit');data.nextCursor=null;}
  if(r.ok&&url.pathname.endsWith('/manifest')){
   const origin=publicOrigin();if(!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin))return deny(res,503);
   for(const a of data.assets||[]){const u=new URL(a.url);if(u.origin!==assetOrigin||!u.pathname.startsWith('/tingyue-published/device-fixture/peter-rabbit-01/'))return deny(res,502);}
   for(const a of data.assets||[]){const token=randomBytes(24).toString('hex');assets.set(token,{url:a.url,until:Math.min(Date.parse(a.expiresAt),end)});a.url=origin+'/assets/'+token;}
  }
  if(r.ok&&req.method==='DELETE')access.delete(bearer);
  const out={'Content-Type':'application/json','Cache-Control':'no-store'};for(const n of ['x-api-contract-version','x-request-id'])if(r.headers.has(n))out[n]=r.headers.get(n);
  res.writeHead(r.status,out);res.end(JSON.stringify(data));
 }catch{if(!res.headersSent)deny(res,502);else res.destroy();}});
}
if(require.main===module){const file=path.resolve(__dirname,'../.cache/device-local/iphone-gateway.json');const config=JSON.parse(fs.readFileSync(file));const server=createGateway({...config,publicOrigin:()=>JSON.parse(fs.readFileSync(file)).publicOrigin||''});server.requestTimeout=20000;server.listen(4182,'127.0.0.1',()=>console.log('iPhone restricted gateway ready on 4182; six-hour lifetime'));}
module.exports={createGateway};
