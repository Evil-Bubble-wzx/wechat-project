const test=require('node:test'),assert=require('node:assert/strict'),{createHash,randomBytes}=require('node:crypto');
test('incremental SHA-256 matches Node for vectors, boundaries and arbitrary chunking',async()=>{
 const {Sha256}=await import('../operations-web/upload-core.mjs');
 for(const length of [0,1,3,55,56,63,64,65,127,1024,8*1024*1024+17]){const bytes=randomBytes(length);const expected=createHash('sha256').update(bytes).digest('hex');for(const chunk of [1,37,8192]){if(length>1024&&chunk===1)continue;const hash=new Sha256();for(let i=0;i<bytes.length;i+=chunk)hash.update(bytes.subarray(i,i+chunk));assert.equal(hash.hex(),expected);assert.throws(()=>hash.hex());}}
});
test('file hashing reads bounded slices and respects cancellation',async()=>{
 const {hashFile}=await import('../operations-web/upload-core.mjs');const bytes=randomBytes(9*1024*1024),reads=[];
 const file={size:bytes.length,slice:(start,end)=>{reads.push([start,end]);return{arrayBuffer:async()=>bytes.subarray(start,end)}}};
 assert.equal(await hashFile(file),createHash('sha256').update(bytes).digest('hex'));assert.equal(reads.length,2);assert.ok(reads.every(([a,b])=>b-a<=8*1024*1024));
 const abort=new AbortController();abort.abort();await assert.rejects(hashFile(file,abort.signal),{name:'AbortError'});
});
test('persisted draft contains no tokens, URLs, ETags or file payload',async()=>{
 const {safeDraft}=await import('../operations-web/upload-core.mjs');const value=safeDraft({owner:'account',batchId:'batch',token:'SECRET',uploadUrl:'SECRET',files:['SECRET'],input:{workId:'work',items:[{clientFileId:'audio',assetType:'audio',fileName:'a.mp3',sha256:'digest',uploadUrl:'SECRET',token:'SECRET',bytes:'SECRET'}]},sessionKeys:{audio:'key',rogue:'SECRET'}});
 assert.equal(JSON.stringify(value).includes('SECRET'),false);assert.equal(value.owner,'account');assert.equal(value.sessionKeys.audio,'key');
});
test('pending processing retry preserves only operation identity across reloads',async()=>{
 const {safeDraft}=await import('../operations-web/upload-core.mjs'),job='11111111-1111-4111-8111-111111111111',key='22222222-2222-4222-8222-222222222222';
 const value=safeDraft({owner:'account',batchId:'batch',cancelKey:key,retryKeys:{[job+':1']:key,'rogue':'SECRET'},pendingRetry:{jobId:job,key,token:'SECRET',uploadUrl:'SECRET'}});
 assert.equal(JSON.stringify(value).includes('SECRET'),false);assert.deepEqual(value.pendingRetry,{jobId:job,key});assert.equal(value.retryKeys[job+':1'],key);assert.equal(value.cancelKey,key);
});
