// Private backup + restore rehearsal. Never prints credentials or row contents.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Pool}=require('pg');
const root=path.resolve(__dirname,'../..');
const tables=['users','user_profiles','user_learning_progress','user_saved_words','quiz_attempts','quiz_answers','learning_score_events','purchase_orders','simulated_payment_events'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const url=new URL(process.env.DATABASE_URL);
if(process.env.APP_ENV!=='local'||url.hostname!=='127.0.0.1'||url.port!=='55433'||url.pathname!=='/tingyue')throw Error('Dedicated local database only');
const docker=args=>execFileSync('docker',['exec','tingyue-device-local-postgres-1',...args],{maxBuffer:128*1024*1024});
async function fingerprints(pool,columns){
  const result={};
  for(const table of tables){
    if(!columns[table])columns[table]=(await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',['public',table])).rows.map(r=>r.column_name);
    if(!columns[table].length)throw Error('Missing learning table');
    const fields=columns[table].map(c=>{if(!/^[a-z_]+$/.test(c))throw Error('Unexpected column');return '"'+c+'"'}).join(',');
    const rows=(await pool.query(`SELECT row_to_json(t)::text AS value FROM (SELECT ${fields} FROM ${table}) t ORDER BY row_to_json(t)::text`)).rows;
    result[table]={count:rows.length,sha256:hash(rows.map(r=>r.value).join('\n')),rowHashes:rows.map(r=>hash(r.value))};
  }
  return result;
}
(async()=>{
  const live=new Pool({connectionString:process.env.DATABASE_URL});
  let restored;
  const [action,dirArg]=process.argv.slice(2);
  try{
    if(action==='verify'){
      const dir=path.resolve(dirArg),allowed=path.join(root,'.cache','device-local');
      if(!dir.startsWith(allowed+path.sep))throw Error('Private backup directory only');
      const saved=JSON.parse(fs.readFileSync(path.join(dir,'receipt.json')));
      const current=await fingerprints(live,saved.columns);
      for(const table of tables){
        const original=saved.fingerprints[table];
        if(original.rowHashes){const present=new Set(current[table].rowHashes);if(original.rowHashes.some(h=>!present.has(h)))throw Error('Original learning or order row changed: '+table)}
        else if(original.sha256!==current[table].sha256||original.count!==current[table].count)throw Error('Learning or order data changed; inspect private backup');
      }
      // A receipt from an earlier tool revision can only gain row hashes after
      // its complete original fingerprint has matched. New test rows may then
      // be added while any change to original facts still fails verification.
      if(!saved.fingerprints[tables[0]].rowHashes){saved.fingerprints=current;fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(saved,null,2))}
      console.log('device.backup.verify.passed: original learning and order rows unchanged');return;
    }
    if(action!=='backup')throw Error('Usage: backup | verify <privateBackupDirectory>');
    const suffix=crypto.randomBytes(6).toString('hex'),dir=path.join(root,'.cache','device-local','upgrade-2026-10-12-'+suffix);
    fs.mkdirSync(dir,{recursive:true});
    const columns={},before=await fingerprints(live,columns);
    const dump=docker(['pg_dump','-U','tingyue','-Fc','tingyue']);
    fs.writeFileSync(path.join(dir,'database.dump'),dump);
    const database='tingyue_restore_'+suffix;
    docker(['createdb','-U','tingyue',database]);
    try{
      execFileSync('docker',['exec','-i','tingyue-device-local-postgres-1','pg_restore','-U','tingyue','--no-owner','--no-acl','--exit-on-error','-d',database],{input:dump,maxBuffer:128*1024*1024});
      const restoredUrl=new URL(url);restoredUrl.pathname='/'+database;
      restored=new Pool({connectionString:restoredUrl.toString()});
      if(JSON.stringify(await fingerprints(restored,columns))!==JSON.stringify(before))throw Error('Restore verification failed');
      fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify({createdAt:new Date().toISOString(),dumpSha256:hash(dump),columns,fingerprints:before,restoreVerified:true},null,2));
      console.log('device.backup.restore.passed directory='+dir+' bytes='+dump.length);
    }finally{if(restored)await restored.end();docker(['dropdb','-U','tingyue',database]);}
  }finally{await live.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
