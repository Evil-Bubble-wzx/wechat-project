const {books}=require('./books')
const mode=require('../../config/product-mode')
const clone=value=>JSON.parse(JSON.stringify(value))
const placeholder='/assets/icon-book.png'
function fromSummary(value){
  if(!value||typeof value.workId!=='string'||!value.workId||value.workId.length>128||value.workId.includes(':')||typeof value.title!=='string'||!value.title||!['free','restricted'].includes(value.access)||!Number.isInteger(value.pieceCount)||value.pieceCount<1)throw new Error('Invalid published work summary')
  const m=value.metadata||{}
  return {id:value.workId,workId:value.workId,title:value.title,zh:m.titleZh??null,author:m.author??null,series:m.series??null,
    editionLabel:m.editionLabel??null,internalContentNumber:m.internalContentNumber??null,number:m.internalContentNumber??value.workId,
    cover:typeof value.coverUrl==='string'?value.coverUrl:placeholder,color:'#edf5ef',category:m.category??null,level:m.level??null,
    pages:m.pageCount??null,words:m.wordCount??null,duration:m.durationMs?m.durationMs/1000:0,displayDuration:m.durationMs?Math.floor(m.durationMs/60000)+':'+String(Math.floor(m.durationMs/1000)%60).padStart(2,'0'):null,
    desc:m.description??null,narrator:m.narrator??null,audioSource:m.audioSource??null,audioSourceUrl:m.audioSourceUrl??null,
    access:value.access,pieceCount:value.pieceCount,chapters:[],remote:true}
}
function fromWork(response){
  const book=fromSummary(response?.work)
  if(!Array.isArray(response.pieces)||!response.pieces.length)throw new Error('Published chapters are missing')
  const ids=new Set()
  book.chapters=response.pieces.map(piece=>{
    if(typeof piece.pieceId!=='string'||!piece.pieceId||piece.pieceId.includes(':')||ids.has(piece.pieceId)||typeof piece.title!=='string'||!Number.isInteger(piece.currentContentVersion)||piece.currentContentVersion<1||!['free','restricted'].includes(piece.access))throw new Error('Invalid chapter identity')
    ids.add(piece.pieceId)
    return {id:piece.pieceId,title:piece.title,contentVersion:piece.currentContentVersion,quizVersion:piece.quizVersion??null,
      hasQuiz:Number.isInteger(piece.quizVersion)&&piece.quizVersion>0,access:piece.access,duration:piece.durationMs?piece.durationMs/1000:0,
      metadata:piece.metadata||{},localAudio:''}
  })
  book.pieceId=book.chapters[0].id;book.contentVersion=book.chapters[0].contentVersion;book.quizVersion=book.chapters[0].quizVersion
  return book
}
function validated(response){
  if(!response||!Array.isArray(response.items)||!(response.nextCursor===null||typeof response.nextCursor==='string'))throw new Error('Invalid catalog response')
  const ids=new Set()
  return response.items.map(item=>{const book=fromSummary(item);if(ids.has(book.id))throw new Error('Duplicate catalog identity');ids.add(book.id);return book})
}
function createCatalog(){
  let scope=null,entries=new Map(),authoritative=false
  const setScope=id=>{if(scope!==id){scope=id||null;entries=new Map();authoritative=false}}
  const bundled=()=>books.filter(book=>mode.current().allowsBook(book.id))
  return {
    setScope,scope:()=>scope,reset:()=>setScope(null),
    list:()=>mode.current().isDemo?clone(books):clone(authoritative?[...entries.values()]:bundled()),
    get:id=>clone(entries.get(id)||(!authoritative?bundled().find(book=>book.id===id):null)||null),
    has:id=>!!entries.get(id),
    replace(response,id,filtered=false){if(scope!==id||!id)return false;const incoming=validated(response);if(!filtered)entries=new Map();for(const book of incoming)entries.set(book.id,book);authoritative=true;return true},
    append(response,id){if(scope!==id||!id)return false;for(const book of validated(response))entries.set(book.id,book);authoritative=true;return true},
    putWork(response,id){if(scope!==id||!id)return null;const book=fromWork(response);entries.set(book.id,book);return clone(book)},
  }
}
const singleton=createCatalog()
module.exports={fromSummary,fromWork,createCatalog,setScope:singleton.setScope,scope:singleton.scope,reset:singleton.reset,list:singleton.list,get:singleton.get,has:singleton.has,replace:singleton.replace,append:singleton.append,putWork:singleton.putWork}
