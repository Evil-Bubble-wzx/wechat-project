// Dedicated internal fixture v2. Keeps v1 assets/quiz/learning history intact.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {loadConfig} from '../src/config.ts';
import {validateCatalogMetadata,validateQuizPackage,validateSubtitleReferences,validateVocabularyPackage} from '../src/content/package-validation.ts';
const config=loadConfig(),db=new URL(config.databaseUrl),source=fileURLToPath(new URL('../../content/peter-rabbit/peter-rabbit-01/',import.meta.url));
if(config.appEnv!=='local'||db.hostname!=='127.0.0.1'||db.port!=='55433'||db.pathname!=='/tingyue'||config.objectStorage.endpoint!=='127.0.0.1'||config.objectStorage.port!==59000)throw Error('Dedicated local fixture only');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const workId='peter-rabbit',pieceId='peter-rabbit-01',version=2;
const files=[['audio','source/audio-original.mp3','audio/mpeg'],['cover','source/cover/peter-rabbit-independent.svg','image/svg+xml'],['text','work/canonical-text.txt','text/plain'],['subtitles','dist/cues.json','application/json'],['vocabulary','dist/vocab.json','application/json'],['quiz','dist/quiz.json','application/json'],['metadata','dist/metadata.json','application/json']];
const rawManifest=JSON.parse(await readFile(source+'dist/manifest.json','utf8'));
const assets=await Promise.all(files.map(async([type,file,mime])=>{
  let bytes=await readFile(source+file);
  if(type==='metadata'||type==='quiz'){const value=JSON.parse(bytes.toString());value.contentVersion=version;bytes=Buffer.from(JSON.stringify(value));}
  return {type,mime,bytes,sha256:hash(bytes),sizeBytes:bytes.length,key:`device-fixture/${pieceId}/v${version}/${hash(bytes)}/${type}`};
}));
if(assets[0].sha256!==rawManifest.audio.sha256)throw Error('Audio source mismatch');
const identity={workId,pieceId,contentVersion:version};
const metadata=validateCatalogMetadata(JSON.parse(assets.find(a=>a.type==='metadata')!.bytes.toString()),identity);
const quiz=validateQuizPackage(JSON.parse(assets.find(a=>a.type==='quiz')!.bytes.toString()),identity);
validateVocabularyPackage(JSON.parse(assets.find(a=>a.type==='vocabulary')!.bytes.toString()));
validateSubtitleReferences(JSON.parse(assets.find(a=>a.type==='subtitles')!.bytes.toString()));
const digest=hash(Buffer.from(JSON.stringify(assets.map(a=>({type:a.type,sha256:a.sha256,sizeBytes:a.sizeBytes})).sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:0))));
const pool=new pg.Pool({connectionString:config.databaseUrl});
const s3=new S3Client({endpoint:'http://127.0.0.1:59000',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:config.objectStorage.accessKey,secretAccessKey:config.objectStorage.secretKey}});
const client=await pool.connect();
try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['internal-fixture-upgrade:'+pieceId]);
  const old=(await client.query("SELECT id FROM content_versions WHERE piece_id=$1 AND content_version=1",[pieceId])).rows[0];
  if(!old)throw Error('Expected existing v1 fixture; seed it first');
  const existing=(await client.query('SELECT id,manifest_sha256 FROM content_versions WHERE piece_id=$1 AND content_version=$2',[pieceId,version])).rows[0];
  if(existing){if(existing.manifest_sha256.trim()!==digest)throw Error('Existing v2 differs; refusing overwrite');await client.query('ROLLBACK');console.log('device.content.upgrade.replayed: v2 preserved');}
  else{
    const current=(await client.query('SELECT current_content_version_id FROM pieces WHERE id=$1 FOR UPDATE',[pieceId])).rows[0];
    if(current?.current_content_version_id!==old.id)throw Error('Unexpected current version; refusing overwrite');
    for(const asset of assets){
      await s3.send(new PutObjectCommand({Bucket:config.objectStorage.publishedBucket,Key:asset.key,Body:asset.bytes,ContentType:asset.mime}));
      const stored=await s3.send(new GetObjectCommand({Bucket:config.objectStorage.publishedBucket,Key:asset.key}));
      if(hash(Buffer.from(await stored.Body!.transformToByteArray()))!==asset.sha256)throw Error('Stored resource digest mismatch');
    }
    const row=(await client.query("INSERT INTO content_versions(piece_id,content_version,status,publishable,manifest_sha256,published_at,catalog_metadata) VALUES($1,$2,'published',true,$3,now(),$4) RETURNING id",[pieceId,version,digest,JSON.stringify(metadata)])).rows[0];
    for(const asset of assets)await client.query("INSERT INTO content_assets(piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'published')",[pieceId,version,asset.type,config.objectStorage.publishedBucket,asset.key,asset.sha256,asset.sizeBytes,asset.mime,asset.type==='audio'?rawManifest.audio.durationMs:null]);
    const pkg=(await client.query("INSERT INTO quiz_packages(piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES($1,$2,$3,$4,'published',$5,now()) RETURNING id",[pieceId,version,quiz.quizVersion,assets.find(a=>a.type==='quiz')!.sha256,quiz.masteryThreshold])).rows[0];
    for(const [index,q]of quiz.questions.entries())await client.query('INSERT INTO quiz_questions(quiz_package_id,question_id,prompt,options,correct_option,sort_order) VALUES($1,$2,$3,$4,$5,$6)',[pkg.id,q.id,q.prompt,JSON.stringify(q.options),q.answer,index]);
    await client.query("UPDATE content_versions SET status='superseded' WHERE id=$1",[old.id]);
    await client.query('UPDATE pieces SET current_content_version_id=$1 WHERE id=$2',[row.id,pieceId]);
    await client.query('COMMIT');
    const dir=fileURLToPath(new URL('../../.cache/device-local/',import.meta.url));await mkdir(dir,{recursive:true});
    await writeFile(dir+'content-fixture-v2.json',JSON.stringify({internalFixtureOnly:true,version,assets:assets.length,questions:quiz.questions.length,manifestSha256:digest,sourcePublishable:rawManifest.publishable,sourceBlockers:rawManifest.blockers},null,2));
    console.log('device.content.upgrade.passed: v2 seven resources verified; v1/history preserved; source gates unchanged');
  }
}catch(e){await client.query('ROLLBACK');throw e}finally{client.release();await pool.end();s3.destroy()}
