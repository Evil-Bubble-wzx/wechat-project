const attempts=require('../quiz/attempts')
const {validSummary,validEntry}=require('../sync/quiz-sync')
const pad=value=>String(value).padStart(2,'0')
function divide(value,divisor){
  let remainder=0,result=''
  for(const digit of value){const n=remainder*10+Number(digit);result+=String(Math.floor(n/divisor));remainder=n%divisor}
  return {value:result.replace(/^0+(?=\d)/,''),remainder}
}
function listeningLabel(ms){
  const seconds=divide(ms,1000).value,hours=divide(seconds,3600),minutes=Math.floor(hours.remainder/60)
  return hours.value==='0'?pad(minutes)+':'+pad(hours.remainder%60):pad(hours.value)+':'+pad(minutes)
}
function view(state){
  const summary=validSummary(state.cloudLearningSummary)?state.cloudLearningSummary:null
  const history=(state.cloudQuizHistory||[]).filter(validEntry).map(entry=>Object.assign({},entry,{
    date:new Date(entry.submittedAt).toLocaleDateString(),scoreLabel:entry.score===null?'—':entry.score+'%',
    statusLabel:entry.status==='withdrawn'?'成绩已撤回 · 不计入统计':entry.status==='rejected'?'服务端已拒绝':!entry.currentCompatible?'服务端已验证 · 历史版本':'服务端已验证',
  }))
  const cloudIds=new Set(history.map(item=>item.attemptId))
  for(const item of state.results||[])if(!cloudIds.has(item.attemptId)){
    const local=attempts.view(item)
    history.push(Object.assign({},local,{scoreLabel:local.score+'%',statusLabel:'本机记录 · '+local.statusLabel}))
  }
  history.sort((a,b)=>(Date.parse(b.submittedAt)||0)-(Date.parse(a.submittedAt)||0)||a.attemptId.localeCompare(b.attemptId))
  const emptyTrend={ready:false,remaining:6,early:null,recent:null,delta:null,pieceCount:0}
  return {
    results:history,reportTrend:summary?summary.trend:emptyTrend,
    reportSourceLabel:summary?'云端验真统计 · 本机待提交不计入':'云端统计待同步 · 不使用本机练习分数',
    reportAsOf:summary?'统计更新：'+new Date(summary.asOf).toLocaleString():'',
    listeningSourceLabel:'有效听读（重复区间不重复累计）',
    stats:{pieces:summary?summary.completedPieces:'—',words:summary&&summary.completedWords!==null?summary.completedWords:'—',
      correct:summary?.averageCorrectPercent??null,correctLabel:summary?.averageCorrectPercent!=null?summary.averageCorrectPercent+'%':'—',
      listening:summary?listeningLabel(summary.listenedMs):'—'},
  }
}
module.exports={view,listeningLabel}
