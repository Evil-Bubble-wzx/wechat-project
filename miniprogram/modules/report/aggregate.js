const attempts = require('../quiz/attempts')
const MIN_TREND_PIECES = 6
const mean = values => values.length?Math.round(values.reduce((sum,value)=>sum+value,0)/values.length):0
function summarize(results, compatiblePieces = {}) {
  const history=(results||[]).map(attempts.view)
  const eligible=history.filter(item=>{
    if(!item.analyticsEligible||item.legacy||!item.pieceId||!item.submittedAt)return false
    const expected=compatiblePieces[item.pieceId]
    return !!expected&&expected.contentVersion===item.contentVersion&&expected.quizVersion===item.quizVersion
  })
  const latestByPiece=new Map()
  for(const item of eligible){const previous=latestByPiece.get(item.pieceId);if(!previous||Date.parse(item.submittedAt)>Date.parse(previous.submittedAt))latestByPiece.set(item.pieceId,item)}
  const latest=[...latestByPiece.values()].sort((a,b)=>Date.parse(a.submittedAt)-Date.parse(b.submittedAt))
  const remaining=Math.max(0,MIN_TREND_PIECES-latest.length)
  let trend={ready:false,remaining,early:null,recent:null,delta:null,pieceCount:latest.length}
  if(!remaining){const size=Math.max(1,Math.floor(latest.length/3)),early=mean(latest.slice(0,size).map(item=>item.score)),recent=mean(latest.slice(-size).map(item=>item.score));trend={ready:true,remaining:0,early,recent,delta:recent-early,pieceCount:latest.length}}
  return {history,latest,average:mean(latest.map(item=>item.score)),trend}
}
module.exports={MIN_TREND_PIECES,summarize}
