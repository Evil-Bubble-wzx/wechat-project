const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
function bridge(fetch){const context={window:{},fetch,AbortController,ArrayBuffer,URLSearchParams,setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(require.resolve('../preview/bridge.js'),'utf8'),context);return context.window.wx.request}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('preview request delivers real binary bytes and response headers without adding API credentials',async()=>{
 let seen;const request=bridge(async(url,options)=>{seen={url,options};return{status:200,headers:[['content-type','application/json']],arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer}})
 const value=await new Promise((resolve,reject)=>request({url:'http://127.0.0.1/asset',responseType:'arraybuffer',success:resolve,fail:reject}))
 assert.deepEqual([...new Uint8Array(value.data)],[1,2,3]);assert.equal(value.statusCode,200);assert.equal(value.header['content-type'],'application/json');assert.equal(seen.options.headers.Authorization,undefined)
})
test('preview request forwards only supplied headers, JSON writes and text responses',async()=>{
 let seen;const request=bridge(async(url,options)=>{seen=options;return{status:201,headers:[],text:async()=>'{"ready":true}'}})
 const value=await new Promise((resolve,reject)=>request({url:'http://127.0.0.1/api',method:'POST',header:{Authorization:'Bearer test'},data:{chapter:1},success:resolve,fail:reject}))
 assert.equal(value.data.ready,true);assert.equal(seen.body,'{"chapter":1}');assert.equal(seen.headers.Authorization,'Bearer test');assert.equal(seen.headers['Content-Type'],'application/json')
 const text=await new Promise((resolve,reject)=>request({url:'http://127.0.0.1/api',dataType:'text',success:resolve,fail:reject}));assert.equal(text.data,'{"ready":true}')
})
test('preview abort completes once and ignores a late network response',async()=>{
 let deliver,success=0,failed=0,completed=0;const request=bridge(()=>new Promise(resolve=>{deliver=resolve}))
 const task=request({url:'http://127.0.0.1/api',success:()=>success++,fail:e=>{failed++;assert.ok(e.errMsg.includes('abort'))},complete:()=>completed++})
 await tick();task.abort();deliver({status:200,headers:[],text:async()=>'{"ready":true}'});await tick();task.abort();assert.deepEqual([success,failed,completed],[0,1,1])
})
test('preview timeout aborts transport and reports stable failure without leaking URLs',async()=>{
 let signal;const request=bridge((_url,options)=>{signal=options.signal;return new Promise(()=>{})})
 const failure=await new Promise(resolve=>request({url:'http://127.0.0.1/private?secret=never-log',timeout:5,fail:resolve}))
 assert.equal(signal.aborted,true);assert.equal(failure.errMsg,'request:fail timeout')
})
