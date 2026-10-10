import pg from 'pg';
import { S3Client,PutObjectCommand } from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config.ts';
import { CommerceService } from '../src/commerce/service.ts';
import { seedCommerceFixture,fixtureAssets } from './commerce-fixture.ts';

const config=loadConfig(),url=new URL(config.databaseUrl);
if(config.appEnv!=='local'||url.hostname!=='127.0.0.1'||url.port!=='55433'||url.pathname!=='/tingyue')throw new Error('Simulation CLI requires the dedicated device-local database');
const pool=new pg.Pool({connectionString:config.databaseUrl});
try{
  const [action,orderId,eventKey,amount]=process.argv.slice(2);
  if(action==='seed'){
    if(config.objectStorage.endpoint!=='127.0.0.1'||config.objectStorage.port!==59000)throw new Error('Requires device-local storage');
    const s3=new S3Client({endpoint:'http://127.0.0.1:59000',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:config.objectStorage.accessKey,secretAccessKey:config.objectStorage.secretKey}});
    try{for(const a of fixtureAssets)await s3.send(new PutObjectCommand({Bucket:config.objectStorage.publishedBucket,Key:`commerce-fixture/v1/${a.type}`,Body:a.bytes,ContentType:a.mime}));await seedCommerceFixture(pool,config.objectStorage.publishedBucket);}finally{s3.destroy();}
    console.log('Original simulation fixture ready; price=100fen; no real charge');
  }else{
    if(!['pay','refund'].includes(action)||!orderId||!eventKey||!amount||process.argv.length!==6)throw new Error('Usage: seed | pay/refund <orderUUID> <uniqueEventKey> <amountFen>');
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(orderId))throw new Error('Invalid UUID');
    const order=await new CommerceService(pool).simulate(orderId,action as 'pay'|'refund',eventKey,Number(amount));
    console.log(JSON.stringify({mode:order.mode,orderId:order.orderId,status:order.status,amountFen:order.amountFen}));
  }
}finally{await pool.end();}
