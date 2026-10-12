const api=require('../services/api'),host=require('../services/host'),points=require('../modules/ranking/learning-points')
let returnContext=null
const sorts=[{id:'date',label:'Date Taken'},{id:'title',label:'Title'},{id:'accuracy',label:'Correct'},{id:'level',label:'Level'},{id:'words',label:'Words'},{id:'quizPoints',label:'Quiz Points'}]
const number=value=>value===null||value===undefined?'—':points.formatPoints(String(value))
const metric=(value,percent)=>value===null||value===undefined?'—':Number(value).toFixed(1)+(percent?'%':'')
const shanghai=value=>{const date=new Date(Date.parse(value)+8*3600000);return Number.isFinite(date.getTime())?date.toISOString().slice(0,16).replace('T',' '):'—'}
function statsRows(stats={}){
 const a=stats.passed||{},b=stats.all||{}
 return [['pieces','Total Chapters',false,true],['words','Total Words',false,true],['earlyCorrect','Early Correct',true],['earlyLevel','Early Level'],['recentCorrect','Rct Correct',true],['recentLevel','Rct Level'],['averageCorrect','Avg Correct',true],['averageLevel','Avg Level'],['fictionPercent','Fiction',true]].map(([key,label,percent,integer])=>({key,label,passed:integer?number(a[key]):metric(a[key],percent),all:integer?number(b[key]):metric(b[key],percent)}))
}
function context(options={}){
 const result={}
 for(const key of ['participantId','snapshotId','campusId','periodType','periodKey','grade','level'])if(typeof options[key]==='string'&&options[key])result[key]=options[key]
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.snapshotId||'')||!/^[a-zA-Z0-9_-]{8,128}$/.test(result.participantId||'')||!/^[a-z][a-z0-9-]{0,31}$/.test(result.campusId||'')||!['rolling7','week','month','year'].includes(result.periodType))return null
 if(result.grade&&!/^(all|k|[1-9])$/.test(result.grade)||result.level&&!/^(all|[1-5])$/.test(result.level))return null
 if(result.periodType==='week'&&!/^\d{4}-W\d{2}$/.test(result.periodKey||'')||result.periodType==='month'&&!/^\d{4}-\d{2}$/.test(result.periodKey||'')||result.periodType==='year'&&result.periodKey&&!/^\d{4}$/.test(result.periodKey))return null
 if(result.periodType==='rolling7')delete result.periodKey
 return result
}
function navigate(options){
 const ctx=context(options)
 if(!ctx||!host.policy().allowsRoute('ranking-detail'))return false
 returnContext={owner:api.currentUser()?.userId,filters:Object.assign({},ctx)}
 wx.navigateTo({url:'/pages/ranking-detail/index?'+Object.entries(ctx).map(([key,value])=>encodeURIComponent(key)+'='+encodeURIComponent(value)).join('&')});return true
}
function createPage(){
 return{
  data:{route:'ranking-detail',title:'Quizzes',inset:24,isTab:false,isDemo:host.policy().isDemo,sheet:'',detail:null,quizzes:[],statsRows:[],status:'idle',notice:'',busy:false,nextCursor:null,query:'',appliedQuery:'',sorts,sortIndex:0,direction:'desc',sortArrow:'↓',totalMatches:0,periodLabel:'',statsOpen:true},
  onLoad(options){this.ctx=context(options);this.owner=api.currentUser()?.userId||null;this.setData({inset:host.inset()});if(!this.ctx)this.setData({status:'error',notice:'详情参数无效，请返回榜单重新打开。'})},
  onShow(){if(this.loaded&&this.current())return;if(this.loaded&&!this.current()){this.epoch=(this.epoch||0)+1;this.setData({detail:null,quizzes:[],statsRows:[],nextCursor:null,busy:false,status:'unauthenticated',notice:'账号已变化，请返回榜单重新打开。'});return}if(this.ctx)this.load()},
  onHide(){this.epoch=(this.epoch||0)+1;this.loaded=false;this.setData({busy:false})},
  onUnload(){this.closed=true;this.epoch=(this.epoch||0)+1},
  current(){return !this.closed&&!!this.owner&&api.isAuthenticated()&&api.currentUser()?.userId===this.owner&&host.accountScope()===this.owner},
  back(){host.back()},
  noop(){},
  toggleStats(){this.setData({statsOpen:!this.data.statsOpen})},
  typeQuery(e){this.setData({query:String(e.detail.value||'').slice(0,128)})},
  search(){this.setData({appliedQuery:this.data.query.trim()});return this.load()},
  clearSearch(){this.setData({query:'',appliedQuery:''});return this.load()},
  chooseSort(e){const index=Number(e.detail.value);if(!sorts[index])return;this.setData({sortIndex:index});return this.load()},
  toggleDirection(){const direction=this.data.direction==='desc'?'asc':'desc';this.setData({direction,sortArrow:direction==='desc'?'↓':'↑'});return this.load()},
  retry(){return this.load(this.failedCursor||undefined)},
  more(){if(this.data.nextCursor&&!this.data.busy)return this.load(this.data.nextCursor)},
  async load(cursor){
   if(!this.ctx)return
   if(!this.current()){this.setData({detail:null,quizzes:[],statsRows:[],nextCursor:null,status:'unauthenticated',notice:'请登录后从榜单打开详情。',busy:false});return}
   if(!api.rankingAnalysisAvailable()){this.setData({status:'unavailable',notice:'服务端尚未提供完整详情，请先更新后端。',busy:false});return}
   if(cursor&&this.data.busy)return
   const epoch=this.epoch=(this.epoch||0)+1,ctx=this.ctx,query=this.data.appliedQuery,sort=sorts[this.data.sortIndex].id,direction=this.data.direction
   const current=()=>this.current()&&this.epoch===epoch
   this.setData({busy:true,status:'loading',notice:'',...(!cursor?{quizzes:[],nextCursor:null}:{})})
   try{
    const response=await api.rankingAnalysis(ctx.participantId,{...ctx,query,sort,direction,cursor,limit:50})
    if(!current())return
    if(response.snapshotId!==ctx.snapshotId||response.participant?.participantId!==ctx.participantId||response.search?.query!==query||response.search?.sort!==sort||response.search?.direction!==direction||response.stats?.schemaVersion!==1)throw new Error('detail_scope_mismatch')
    const items=(response.quizzes||[]).map(item=>({attemptId:item.attemptId,title:item.title,series:item.series||'',author:item.author||'',workId:item.workId,pieceId:item.pieceId,takenAt:shanghai(item.takenAt),correctLabel:metric(item.correctPercent,true),levelLabel:metric(item.level),categoryLabel:item.category==='fiction'?'F':item.category==='nonfiction'?'NF':'—',wordsLabel:number(item.wordCount),passedLabel:item.passed?'PASSED':'NOT PASSED',passed:item.passed,quizPoints:number(item.quizPoints),contentVersion:item.contentVersion}))
    const previous=cursor?this.data.quizzes:[],ids=new Set(previous.map(item=>item.attemptId))
    const participant=response.participant
    const detail={displayName:participant.displayName,gradeLabel:participant.gradeLabel||'—',levelLabel:participant.readingLevelLabel||'—',rankingScore:number(response.rankingScore),scoreBreakdown:(response.scoreBreakdown||[]).map(item=>({key:item.key,label:item.label,points:number(item.points),quantity:number(item.quantity),unit:item.unit})),attempts:response.stats.attempts,passedAttempts:response.stats.passedAttempts}
    this.loaded=true;this.failedCursor=null
    this.setData({detail,quizzes:[...previous,...items.filter(item=>!ids.has(item.attemptId))],statsRows:statsRows(response.stats),periodLabel:shanghai(response.startsAt)+' ～ '+shanghai(response.endsAt)+'（结束不包含）',totalMatches:response.totalMatches,nextCursor:response.nextCursor||null,status:'ready',notice:''})
   }catch(error){if(current()){this.failedCursor=cursor;this.setData({status:'error',notice:error.serverCode==='RANKING_UNAVAILABLE'?'快照暂无完整统计，请返回榜单刷新。':cursor?'加载更多失败，可重试；已加载记录保留。':'详情加载失败，请重试。'})}}
   finally{if(current())this.setData({busy:false})}
  }
 }
}
module.exports={createPage,navigate,context,statsRows,shanghai,returnFilters:userId=>userId&&userId===returnContext?.owner?Object.assign({},returnContext.filters):null}
