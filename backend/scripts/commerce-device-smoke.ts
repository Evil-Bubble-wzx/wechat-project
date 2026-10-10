import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { CommerceService } from '../src/commerce/service.ts';
import { fixtureBundle,fixturePiece,fixtureText } from './commerce-fixture.ts';
const config=loadConfig(),url=new URL(config.databaseUrl);
if(config.appEnv!=='local'||url.hostname!=='127.0.0.1'||url.port!=='55433'||url.pathname!=='/tingyue')throw Error('Dedicated local fixture only');
const pool=new pg.Pool({connectionString:config.databaseUrl});
let token='';
const request=async(path:string,body?:unknown)=>fetch('http://127.0.0.1:3100/api/v1'+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':randomUUID()},body:body?JSON.stringify(body):undefined});
try{
  const login=await request('/session/wechat',{code:'test:commerce-device-smoke#ticket-'+randomUUID(),deviceId:'commerce-smoke-device'});assert.equal(login.status,201);token=(await login.json() as any).accessToken;
  const response=await request('/me/orders',{bundleId:fixtureBundle,bundleVersion:1});assert.equal(response.status,200);const order=(await response.json() as any).order;
  const path=`/pieces/${fixturePiece}/manifest?contentVersion=1`;
  assert.equal((await request(path)).status,403);
  const service=new CommerceService(pool);await service.simulate(order.orderId,'pay','live-pay-'+order.orderId,100);
  try{
    const manifest=await request(path);assert.equal(manifest.status,200);const data=await manifest.json() as any;
    const text=data.assets.find((a:any)=>a.type==='text'),download=await fetch(text.url);assert.equal(download.status,200);assert.equal(await download.text(),fixtureText);
  }finally{await service.simulate(order.orderId,'refund','live-refund-'+order.orderId,100);}
  assert.equal((await request(path)).status,403);
  const anonymous=await fetch('http://127.0.0.1:4181/api/v1/bundles');assert.equal(anonymous.status,401);
  const gateway=JSON.parse(readFileSync(new URL('../../.cache/device-local/gateway.json',import.meta.url),'utf8'));
  const blocked=await fetch('http://127.0.0.1:4181/api/v1/bundles',{headers:{'X-Device-Test-Key':gateway.accounts[0].key}});assert.equal(blocked.status,404,'authorized gateway clients must not reach commerce');
  console.log('commerce.device.smoke.passed: running API + private S3 download + refund revocation + gateway remains closed');
}finally{await pool.end();}
