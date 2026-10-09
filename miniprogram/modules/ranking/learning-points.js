const RULE_VERSION='learning-points-v2'
function normalizePoints(value){if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)return null;value=String(value)}return typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)?value:null}
function formatPoints(value){const points=normalizePoints(value);return points===null?'—':points.replace(/\B(?=(\d{3})+(?!\d))/g,',')}
function applyConfirmed(state,summary){
  if(!summary||summary.ruleVersion!==RULE_VERSION||normalizePoints(summary.totalPoints)===null||!Number.isFinite(Date.parse(summary.asOf)))return state
  const previous=state.learningScoreSummary
  if(previous&&Date.parse(previous.asOf)>Date.parse(summary.asOf))return state
  state.learningScoreSummary={ruleVersion:summary.ruleVersion,totalPoints:summary.totalPoints,asOf:summary.asOf,breakdown:summary.breakdown||[]}
  return state
}
function view(state,authenticated){
  const confirmed=authenticated&&state.learningScoreSummary?.ruleVersion===RULE_VERSION
  const pending=Object.keys(state.progressSyncOutbox||{}).length>0
  return {learningPoints:confirmed?formatPoints(state.learningScoreSummary.totalPoints):'—',learningPointsLabel:!authenticated?'登录并同步后计入积分':pending?'已确认积分 · 新进度待同步':confirmed?'服务端已确认 · 累计无上限':'积分待服务端确认'}
}
function ruleText(rules){return Object.values(rules||{}).map(rule=>rule.label+'每'+rule.unit+' +'+formatPoints(rule.pointsPerUnit)+'分').join('；')}
module.exports={RULE_VERSION,normalizePoints,formatPoints,applyConfirmed,view,ruleText}
