const ATTEMPT_SCHEMA_VERSION = 1
const statuses = ['local_unverified','server_verified','rejected']

const iso = value => {
  const date=value instanceof Date?value:new Date(value)
  return Number.isFinite(date.getTime())?date.toISOString():null
}
const pieceId = book => book.chapterId||book.pieceId||book.id
function validate(attempt) {
  const errors=[]
  if(attempt.schemaVersion!==ATTEMPT_SCHEMA_VERSION)errors.push('unsupported schemaVersion')
  for(const key of ['attemptId','workId','pieceId'])if(!String(attempt[key]||'').trim())errors.push('missing '+key)
  if(!statuses.includes(attempt.status))errors.push('invalid status')
  if(!Array.isArray(attempt.questionIds)||!attempt.questionIds.length||attempt.questionIds.some(value=>!String(value||'').trim()))errors.push('missing questionIds')
  if(!Array.isArray(attempt.selectedOptions)||attempt.selectedOptions.length!==attempt.questionIds.length||attempt.selectedOptions.some(value=>!Number.isInteger(value)||value<0))errors.push('invalid selectedOptions')
  if(!iso(attempt.startedAt)||!iso(attempt.submittedAt))errors.push('invalid timestamps')
  if(attempt.status!=='rejected'&&(!Number.isFinite(attempt.score)||typeof attempt.mastery!=='boolean'))errors.push('feedback missing')
  return {valid:!errors.length,errors}
}
function createLocalAttempt({quizPackage,book,selectedOptions,startedAt,submittedAt=new Date(),attemptId}) {
  const questions=quizPackage.questions||[]
  if(!questions.length||!Array.isArray(selectedOptions)||selectedOptions.length!==questions.length||selectedOptions.some((value,index)=>!Number.isInteger(value)||value<0||value>=(questions[index].options||[]).length))throw new Error('Invalid Quiz answers')
  const correct=selectedOptions.reduce((total,value,index)=>total+(value===questions[index].answer?1:0),0)
  const score=questions.length?Math.round(correct/questions.length*100):0
  const submitted=iso(submittedAt)
  const attempt={
    attemptId:attemptId||['local',pieceId(book),Date.parse(submitted),Math.random().toString(36).slice(2,8)].join('-'),
    schemaVersion:ATTEMPT_SCHEMA_VERSION,
    workId:book.workId||book.id,
    pieceId:pieceId(book),
    contentVersion:quizPackage.contentVersion??book.contentVersion??null,
    quizVersion:quizPackage.quizVersion??null,
    questionIds:questions.map(question=>question.id),
    selectedOptions:[...selectedOptions],
    startedAt:iso(startedAt)||submitted,
    submittedAt:submitted,
    status:'local_unverified',
    score,
    mastery:score>=(quizPackage.masteryFeedbackPercent??80),
    title:book.chapterTitle||book.title
  }
  const checked=validate(attempt)
  if(!checked.valid)throw new Error('Invalid Quiz attempt: '+checked.errors.join(', '))
  return attempt
}
function legacyView(result) {
  const fingerprint=[result.id,result.pieceId,result.title,result.date,result.score].filter(value=>value!==undefined&&value!==null).join('-')||'unknown'
  return {attemptId:'legacy-'+fingerprint,schemaVersion:0,workId:result.workId||result.bookId||null,pieceId:result.pieceId||null,contentVersion:result.contentVersion??null,quizVersion:result.quizVersion??null,questionIds:Array.isArray(result.questionIds)?result.questionIds:[],selectedOptions:[],startedAt:null,submittedAt:null,status:'local_unverified',score:Number(result.score)||0,mastery:!!result.mastery,title:result.title||'Quiz',legacy:true,analyticsEligible:false,date:result.date||'旧版本机记录',statusLabel:'旧版本机记录'}
}
function view(result) {
  if(!validate(result).valid)return legacyView(result)
  return Object.assign({},result,{legacy:false,analyticsEligible:result.status!=='rejected',date:new Date(result.submittedAt).toLocaleDateString(),statusLabel:result.status==='server_verified'?'服务端已验证':result.status==='rejected'?'记录已拒绝':'本机练习 · 未服务端验证'})
}

module.exports={ATTEMPT_SCHEMA_VERSION,statuses,validate,createLocalAttempt,view}
