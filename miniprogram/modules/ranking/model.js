const METRIC_KEY = 'rankingScore'
const METRIC_LABEL = 'Quiz Score'
const sortOptions = [
  { id:'takenAt', label:'Date Taken' },
  { id:'correct', label:'Correct' },
  { id:'level', label:'Level' },
  { id:'title', label:'Title' }
]

let lastSelection = null

const numeric = value => value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value))
const number = (value, fallback = 0) => numeric(value) ? Number(value) : fallback
const count = value => Math.max(0, Math.floor(number(value)))
const text = (value, fallback = '') => String(value ?? '').trim() || fallback
const dateValue = value => {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}
const dateLabel = value => {
  const date = dateValue(value)
  if (!date) return '—'
  const pad = part => String(part).padStart(2,'0')
  return date.getFullYear()+'.'+pad(date.getMonth()+1)+'.'+pad(date.getDate())
}
const percent = value => numeric(value) ? Math.max(0,Math.min(100,Number(value))).toFixed(1).replace(/\.0$/,'')+'%' : '—'
const decimal = value => numeric(value) ? Number(value).toFixed(1).replace(/\.0$/,'') : '—'
const integer = value => numeric(value) ? Math.max(0,Math.round(Number(value))).toLocaleString('en-US') : '—'

function rankBadge(rank) {
  return ({1:'🥇',2:'🥈',3:'🥉'})[rank] || String(rank)
}

function normalizeEntry(input = {}) {
  const metric=input.metric||{}
  const hasNamedMetric=metric.key===METRIC_KEY
  const hasDirectMetric=Number.isFinite(Number(input.rankingScore))
  const metricValue=Math.min(1000,count(hasNamedMetric?metric.value:hasDirectMetric?input.rankingScore:0))
  return {
    rank:Math.max(1,count(input.rank)||1),
    rankBadge:rankBadge(Math.max(1,count(input.rank)||1)),
    participantId:text(input.participantId),
    displayName:text(input.displayName,'Anonymous Reader'),
    gradeLabel:text(input.gradeLabel),
    readingLevelLabel:text(input.readingLevelLabel),
    isCurrentUser:!!input.isCurrentUser,
    metricAccepted:hasNamedMetric||hasDirectMetric,
    metricKey:METRIC_KEY,
    metricLabel:METRIC_LABEL,
    metricValue,
    metricValueLabel:metricValue+' 分'
  }
}

function normalizeLeaderboard(payload = {}) {
  const items=Array.isArray(payload.items)?payload.items.map(normalizeEntry).filter(item=>item.participantId&&item.metricAccepted):[]
  const status=['unavailable','cohort_too_small','ready'].includes(payload.status)?payload.status:(items.length?'ready':'unavailable')
  const startsAt=payload.startsAt||payload.windowStart||null
  const endsAt=payload.endsAt||payload.windowEnd||null
  return {
    status,
    items:status==='ready'?items:[],
    ruleVersion:text(payload.ruleVersion),
    startsAt,
    endsAt,
    rangeLabel:startsAt&&endsAt?dateLabel(startsAt)+' – '+dateLabel(endsAt):'',
    generatedAt:payload.generatedAt||null
  }
}

function statRows(stats = {}, fallbackCompletedBooks = 0) {
  const completedBooks=count(stats.completedBooks ?? fallbackCompletedBooks)
  const allBooks=Math.max(completedBooks,count(stats.allBooks ?? completedBooks))
  return [
    { key:'books', label:'Quiz Books', completed:integer(completedBooks), all:integer(allBooks) },
    { key:'words', label:'Total Words', completed:integer(stats.completedWords), all:integer(stats.allWords) },
    { key:'correct', label:'Avg. Correct', completed:percent(stats.completedAverageCorrect), all:percent(stats.allAverageCorrect) },
    { key:'level', label:'Avg. Level', completed:decimal(stats.completedAverageLevel), all:decimal(stats.allAverageLevel) },
    { key:'fiction', label:'Fiction', completed:percent(stats.completedFictionPercent), all:percent(stats.allFictionPercent) }
  ]
}

function normalizeQuiz(input = {}, index = 0) {
  const takenAt=input.takenAt||input.submittedAt||null
  const correct=number(input.correctPercent ?? input.score,NaN)
  const level=number(input.level,NaN)
  const category=text(input.category).toLowerCase()
  return {
    attemptId:text(input.attemptId||input.id,'quiz-'+index),
    pieceId:text(input.pieceId),
    title:text(input.title,'Untitled Book'),
    series:text(input.series),
    author:text(input.author),
    takenAt,
    takenAtLabel:dateLabel(takenAt),
    correct,
    correctLabel:percent(correct),
    level,
    levelLabel:decimal(level),
    category,
    categoryLabel:category==='fiction'?'Fiction':category==='nonfiction'?'Nonfiction':text(input.categoryLabel,'—'),
    wordCount:count(input.wordCount),
    wordCountLabel:integer(input.wordCount),
    completed:input.completed!==false
  }
}

function normalizeDetail(payload = {}, fallback = {}) {
  const participant=payload.participant||{}
  const quizzes=Array.isArray(payload.quizzes)?payload.quizzes.map(normalizeQuiz):[]
  const participantId=text(participant.participantId||payload.participantId||fallback.participantId)
  const displayName=text(participant.displayName||payload.displayName||fallback.displayName,'Anonymous Reader')
  const completedBooks=count(payload.stats?.completedBooks)
  const rankingScore=Math.min(1000,count(payload.rankingScore ?? fallback.metricValue))
  const scoreBreakdown=Array.isArray(payload.scoreBreakdown)?payload.scoreBreakdown.map(item=>({
    key:text(item.key),
    label:text(item.label),
    points:count(item.points),
    maxPoints:count(item.maxPoints),
    pointsLabel:count(item.points)+' / '+count(item.maxPoints)
  })).filter(item=>item.key&&item.label):[]
  const startsAt=payload.startsAt||payload.windowStart||fallback.startsAt||null
  const endsAt=payload.endsAt||payload.windowEnd||fallback.endsAt||null
  const status=['ready','unavailable','cohort_too_small'].includes(payload.status)?payload.status:(payload.quizzes?'ready':'unavailable')
  return {
    status,
    participantId,
    displayName,
    gradeLabel:text(participant.gradeLabel||payload.gradeLabel||fallback.gradeLabel,'—'),
    readingLevelLabel:text(participant.readingLevelLabel||payload.readingLevelLabel||fallback.readingLevelLabel,'—'),
    periodLabel:text(payload.periodLabel||fallback.periodLabel,'Quiz period'),
    startsAt,
    endsAt,
    rangeLabel:startsAt&&endsAt?dateLabel(startsAt)+' – '+dateLabel(endsAt):text(fallback.rangeLabel),
    rankingScore,
    rankingScoreLabel:rankingScore+' 分',
    ruleVersion:text(payload.ruleVersion||fallback.ruleVersion,'quiz-score-v1'),
    scoreBreakdown,
    statsRows:statRows(payload.stats,completedBooks),
    quizzes,
    quizCount:quizzes.length
  }
}

function visibleQuizzes(quizzes, query = '', sort = 'takenAt') {
  const needle=text(query).toLowerCase()
  const filtered=(quizzes||[]).filter(item=>!needle||[item.title,item.series,item.author,item.pieceId].some(value=>text(value).toLowerCase().includes(needle)))
  const sorted=[...filtered]
  sorted.sort((a,b)=>{
    if(sort==='correct')return number(b.correct,-1)-number(a.correct,-1)||text(a.title).localeCompare(text(b.title))
    if(sort==='level')return number(b.level,-1)-number(a.level,-1)||text(a.title).localeCompare(text(b.title))
    if(sort==='title')return text(a.title).localeCompare(text(b.title))
    return number(dateValue(b.takenAt)?.getTime(),0)-number(dateValue(a.takenAt)?.getTime(),0)
  })
  return sorted
}

function rememberSelection(entry, context = {}) {
  lastSelection={entry:normalizeEntry(entry),context:Object.assign({},context)}
  return lastSelection
}

function selection(participantId) {
  if(!lastSelection||text(lastSelection.entry.participantId)!==text(participantId))return null
  return lastSelection
}

module.exports={METRIC_KEY,METRIC_LABEL,sortOptions,normalizeEntry,normalizeLeaderboard,normalizeDetail,visibleQuizzes,rememberSelection,selection}
