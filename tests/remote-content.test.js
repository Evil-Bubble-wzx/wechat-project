const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {sha256Bytes}=require('../miniprogram/modules/sync/local-import')
const {loadBundle}=require('../miniprogram/modules/catalog/remote-resources')
const catalog=require('../miniprogram/modules/catalog/remote-catalog')
const api=require('../miniprogram/services/api'),host=require('../miniprogram/services/host')
const {createPage}=require('../miniprogram/ui/controller')
const identity={workId:'cloud-book',pieceId:'cloud-book-02',contentVersion:2}
function fixture(overrides={}){
  const values={audio:Buffer.from('audio'),cover:Buffer.from('cover'),text:Buffer.from('A cloud story.'),
    subtitles:Buffer.from(JSON.stringify([{id:'c1',startMs:0,endMs:9000,text:'cloud',tokens:[{surface:'cloud',vocabKey:'cloud:noun:1'}]}])),
    vocabulary:Buffer.from(JSON.stringify({'cloud:noun:1':{entryId:'ve-aaaaaaaaaaaa',lemma:'cloud',definitionZh:'云'}})),
    quiz:Buffer.from(JSON.stringify({...identity,schemaVersion:1,quizVersion:3,questions:[{id:'cloud-q1',q:'Which word?',options:['cloud','earth'],answer:0}]})),
    metadata:Buffer.from(JSON.stringify({...identity,schemaVersion:1,title:'Cloud',wordCount:{value:2},durationMs:10000,...overrides}))}
  const assets=Object.entries(values).sort(([a],[b])=>a<b?-1:1).map(([type,bytes])=>({type,url:'https://content.test/'+type,sizeBytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),mimeType:['audio','cover','text'].includes(type)?'text/plain':'application/json'}))
  const manifest={...identity,quizVersion:3,durationMs:10000,assets,manifestSha256:crypto.createHash('sha256').update(JSON.stringify(assets.map(({type,sha256,sizeBytes})=>({type,sha256,sizeBytes})))).digest('hex')}
  return {values,manifest,read:asset=>values[asset.type]}
}
const summary=id=>({workId:id,title:id,coverUrl:null,pieceCount:1,access:'free',metadata:{author:null,category:null,wordCount:null,pageCount:null}})
const work=()=>({work:summary('cloud-book'),pieces:[{pieceId:'cloud-book-02',title:'Chapter Two',currentContentVersion:2,quizVersion:3,durationMs:10000,access:'free',metadata:{}}]})
test('byte SHA-256 matches Node for binary, BOM and multilingual bytes',()=>{
  for(const value of [Buffer.from([0,255,128,65]),Buffer.from('\uFEFFcloud 云 🙂'),crypto.randomBytes(180)])assert.equal(sha256Bytes(value),crypto.createHash('sha256').update(value).digest('hex'))
})
test('remote bundle validates all checksums and keeps matching subtitles words and Quiz',async()=>{
  const f=fixture(),bundle=await loadBundle(f.manifest,identity,{fetchBytes:f.read})
  assert.equal(bundle.quizVersion,3);assert.equal(bundle.cues[0].id,'c1');assert.equal(bundle.vocabulary['cloud:noun:1'].definitionZh,'云')
})
test('remote bundle rejects corruption, wrong versions and incomplete manifests',async()=>{
  const f=fixture()
  await assert.rejects(loadBundle(f.manifest,identity,{fetchBytes:asset=>asset.type==='metadata'?Buffer.from('corrupt'):f.read(asset)}),/checksum/)
  const wrong=fixture({contentVersion:1})
  await assert.rejects(loadBundle(wrong.manifest,identity,{fetchBytes:wrong.read}),/version/)
  await assert.rejects(loadBundle({...f.manifest,assets:f.manifest.assets.slice(1)},identity,{fetchBytes:f.read}),/Complete/)
  await assert.rejects(loadBundle({...f.manifest,pieceId:'other-piece'},identity,{fetchBytes:f.read}),/identity/)
})
test('verified resources reuse only the same account and immutable version, with fresh signed URLs',async()=>{
  const resources=require('../miniprogram/modules/catalog/remote-resources');resources.clearCache()
  const f=fixture();let reads=0;const fetchBytes=asset=>{reads++;return f.values[asset.type]}
  try{
    const first=await loadBundle(f.manifest,identity,{accountScope:'a',fetchBytes});assert.equal(reads,4)
    first.quiz.questions[0].q='Mutated by caller'
    const renewed=JSON.parse(JSON.stringify(f.manifest));renewed.assets.forEach(a=>a.url+='?new-lease')
    const second=await loadBundle(renewed,identity,{accountScope:'a',fetchBytes});assert.equal(reads,4);assert.equal(second.quiz.questions[0].q,'Which word?');assert.ok(second.audioUrl.endsWith('?new-lease'))
    await loadBundle(f.manifest,identity,{accountScope:'b',fetchBytes});assert.equal(reads,8)
    const changed=fixture({title:'Changed immutable content'});await loadBundle(changed.manifest,identity,{accountScope:'b',fetchBytes:asset=>{reads++;return changed.values[asset.type]}});assert.equal(reads,12)
    resources.clearCache();await loadBundle(f.manifest,identity,{accountScope:'a',fetchBytes});assert.equal(reads,16)
  }finally{resources.clearCache()}
})
test('encoded chapter navigation resolves the work and keeps its Quiz available',async()=>{
  await stubs({available:()=>false,isAuthenticated:()=>true,currentUser:()=>({userId:'a'}),dynamicCatalogAvailable:()=>true},async()=>{
    host.setAccountScope('a');catalog.setScope('a');catalog.replace({items:[summary('cloud-book')],nextCursor:null},'a');catalog.putWork(work(),'a')
    const p=page('quiz');p.onLoad({id:encodeURIComponent('cloud-book:cloud-book-02')})
    try{assert.equal(p.data.book.id,'cloud-book');assert.equal(p.data.book.chapterId,'cloud-book-02');assert.equal(p.data.book.hasQuiz,true)}finally{p.onUnload()}
  })
})
test('catalog uses published metadata without borrowing local fields and isolates accounts',()=>{
  const c=catalog.createCatalog();c.setScope('a');c.replace({items:[summary('new-work')],nextCursor:null},'a')
  const b=c.get('new-work');assert.equal(b.author,null);assert.equal(b.words,null);assert.deepEqual(b.chapters,[])
  c.putWork(work(),'a');assert.equal(c.get('cloud-book').chapters[0].contentVersion,2)
  c.setScope('b');assert.equal(c.has('cloud-book'),false);assert.equal(c.replace({items:[summary('leaked')],nextCursor:null},'a'),false)
})
async function stubs(values,run){const old={};for(const [key,value]of Object.entries(values)){old[key]=api[key];api[key]=value}const prev=global.wx;global.wx={getStorageSync:()=>({}),setStorageSync:()=>{},showToast:()=>{},request:()=>{}};try{return await run()}finally{for(const [key,value]of Object.entries(old))api[key]=value;global.wx=prev;host.setAccountScope(null);catalog.reset()}}
function page(route){const p=createPage(route);p.setData=patch=>Object.assign(p.data,patch);return p}
test('catalog search and pagination use backend filters and hide stale query replies',async()=>{
  let release
  await stubs({available:()=>true,isAuthenticated:()=>true,currentUser:()=>({userId:'a'}),dynamicCatalogAvailable:()=>true,listWorks:async(_cursor,_limit,filters)=>filters.query==='old'?new Promise(r=>release=r):{items:[summary(filters.query||'cloud-book')],nextCursor:'next'}},async()=>{
    host.setAccountScope('a');const p=page('library');p.data.query='old';const old=p.loadRemoteCatalog()
    p.data.query='fresh';await p.loadRemoteCatalog();release({items:[summary('stale')],nextCursor:null});await old
    assert.deepEqual(p.data.shown.map(b=>b.id),['fresh']);assert.equal(catalog.has('stale'),false)
  })
})
test('remote catalog drops a reply after account switch',async()=>{
  let userId='a',release
  await stubs({available:()=>true,isAuthenticated:()=>true,currentUser:()=>({userId}),dynamicCatalogAvailable:()=>true,listWorks:()=>new Promise(r=>release=r)},async()=>{
    host.setAccountScope('a');const p=page('home'),pending=p.loadRemoteCatalog();userId='b';host.setAccountScope('b');catalog.setScope('b');release({items:[summary('private-a')],nextCursor:null});await pending
    assert.equal(catalog.has('private-a'),false);assert.equal(p.data.books.some(b=>b.id==='private-a'),false)
  })
})
test('remote chapter loads its own complete bundle and preserves a started same-version Quiz',async()=>{
  const f=fixture()
  await stubs({available:()=>true,isAuthenticated:()=>true,currentUser:()=>({userId:'a'}),dynamicCatalogAvailable:()=>true,getWork:async()=>work(),getManifest:async()=>f.manifest},async()=>{
    global.wx.request=options=>options.success({statusCode:200,data:f.values[options.url.split('/').at(-1)]})
    host.setAccountScope('a');catalog.setScope('a');catalog.putWork(work(),'a')
    const p=page('quiz');p.data.book={...catalog.get('cloud-book'),chapterId:'cloud-book-02'};p.setupQuiz();assert.equal(p.questions.length,0)
    await p.loadRemoteContent();assert.equal(p.questions[0].id,'cloud-q1');assert.equal(p.data.book.localAudio,'https://content.test/audio');assert.equal(p.cuesForBook()[0].text,'cloud')
    p.data.answer=1;p.data.checked=true;await p.loadRemoteContent();assert.equal(p.data.answer,1);assert.equal(p.data.checked,true)
  })
})

test('filtered catalog results keep other books cached without reusing stale chapters',()=>{
  const c=catalog.createCatalog();c.setScope('a');c.replace({items:[summary('keep')],nextCursor:null},'a');c.putWork(work(),'a')
  c.replace({items:[summary('cloud-book')],nextCursor:null},'a',true)
  assert.equal(c.has('keep'),true);assert.deepEqual(c.get('cloud-book').chapters,[])
  assert.equal(c.get('peter'),null)
  assert.throws(()=>c.append({items:[summary('x'),summary('x')],nextCursor:null},'a'),/Duplicate/)
})

test('unknown remote chapter never silently opens the first chapter',async()=>{
  await stubs({available:()=>false,isAuthenticated:()=>true,currentUser:()=>({userId:'a'}),dynamicCatalogAvailable:()=>true},async()=>{
    host.setAccountScope('a');catalog.setScope('a');catalog.putWork(work(),'a')
    const p=page('quiz');p.onLoad({id:'cloud-book:missing'});assert.equal(p.data.book.chapterId,'missing');assert.equal(p.questions.length,0);p.onUnload()
  })
})

test('late bundle for a different chapter cannot replace the current Quiz',async()=>{
  let release
  const f=fixture(),two=work();two.pieces.push({...two.pieces[0],pieceId:'cloud-book-03',title:'Chapter Three'})
  await stubs({available:()=>true,isAuthenticated:()=>true,currentUser:()=>({userId:'a'}),dynamicCatalogAvailable:()=>true,getWork:async()=>two,getManifest:()=>new Promise(r=>release=r)},async()=>{
    global.wx.request=options=>options.success({statusCode:200,data:f.values[options.url.split('/').at(-1)]})
    host.setAccountScope('a');catalog.setScope('a');catalog.putWork(two,'a')
    const p=page('quiz');p.data.book={...catalog.get('cloud-book'),chapterId:'cloud-book-02',pieceId:'cloud-book-02'};p.setupQuiz()
    const pending=p.loadRemoteContent();await new Promise(r=>setImmediate(r))
    p.data.book={...p.data.book,chapterId:'cloud-book-03',pieceId:'cloud-book-03'};release(f.manifest);await pending
    assert.equal(p.data.book.chapterId,'cloud-book-03');assert.equal(p.remoteBundle,undefined);assert.equal(p.questions.length,0)
  })
})

test('cloud checkpoint is pulled before selecting the audio track',async()=>{
  const f=fixture(),progress=require('../miniprogram/modules/sync/progress-sync'),player=require('../miniprogram/modules/listen-read/player')
  const oldPull=progress.pullPiece,oldSelect=player.selectTrack,oldSnapshot=player.snapshot
  let pulled=false,selected=false
  try{
    progress.pullPiece=async()=>{await new Promise(r=>setImmediate(r));pulled=true}
    player.snapshot=()=>({pieceId:null,status:'idle'});player.selectTrack=()=>{assert.equal(pulled,true);selected=true}
    await stubs({available:()=>true,isAuthenticated:()=>true,currentUser:()=>({userId:'a'}),dynamicCatalogAvailable:()=>true,getWork:async()=>work(),getManifest:async()=>f.manifest},async()=>{
      global.wx.request=options=>options.success({statusCode:200,data:f.values[options.url.split('/').at(-1)]})
      host.setAccountScope('a');catalog.setScope('a');catalog.putWork(work(),'a')
      const p=page('player');p.data.book={...catalog.get('cloud-book'),chapterId:'cloud-book-02'};await p.loadRemoteContent();assert.equal(selected,true)
    })
  }finally{progress.pullPiece=oldPull;player.selectTrack=oldSelect;player.snapshot=oldSnapshot}
})

test('chapter switch waits for verified remote audio and rejects old-version playback state',async()=>{
  const player=require('../miniprogram/modules/listen-read/player'),oldPause=player.pause,oldSelect=player.selectTrack
  let paused=false,requested
  try{
    player.pause=()=>{paused=true};player.selectTrack=()=>assert.fail('Unverified remote audio must not be selected')
    await stubs({available:()=>true,isAuthenticated:()=>true,currentUser:()=>({userId:'a'}),dynamicCatalogAvailable:()=>true},async()=>{
      host.setAccountScope('a');catalog.setScope('a');const two=work();two.pieces.push({...two.pieces[0],pieceId:'cloud-book-03',title:'Chapter Three'});const full=catalog.putWork(two,'a')
      const p=page('player');p.data.book={...full,chapterId:'cloud-book-02',pieceId:'cloud-book-02'}
      catalog.replace({items:[summary('cloud-book')],nextCursor:null},'a',true)
      p.loadRemoteContent=async()=>{requested=p.data.book.chapterId};await p.nextTrack({currentTarget:{dataset:{step:1}}})
      assert.equal(requested,'cloud-book-03');assert.equal(paused,true)
      p.syncPlayer({pieceId:'cloud-book-03',book:{...p.data.book,contentVersion:1},status:'playing',position:5},true)
      assert.equal(p.data.book.contentVersion,2);assert.equal(p.data.position,0)
    })
  }finally{player.pause=oldPause;player.selectTrack=oldSelect}
})
