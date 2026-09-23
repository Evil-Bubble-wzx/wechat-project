const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const attempts = require('../miniprogram/modules/quiz/attempts')
const report = require('../miniprogram/modules/report/aggregate')
const ranking = require('../miniprogram/modules/ranking/state')
const quizPackage = require('../miniprogram/modules/listen-read/peter-quiz-data')

const book = { id:'peter-rabbit', workId:'peter-rabbit', pieceId:'peter-rabbit-01', contentVersion:1, title:'The Tale of Peter Rabbit' }
const selectedOptions = () => quizPackage.questions.map(question => question.answer)
const makeAttempt = (pieceId,score,submittedAt,overrides={}) => Object.assign({
  attemptId:'attempt-'+pieceId+'-'+submittedAt,
  schemaVersion:1,
  workId:'work',
  pieceId,
  contentVersion:1,
  quizVersion:1,
  questionIds:['q1'],
  selectedOptions:[0],
  startedAt:submittedAt,
  submittedAt,
  status:'local_unverified',
  score,
  mastery:score>=80,
  title:pieceId
},overrides)

test('generated Peter quiz module keeps the reviewed package identity', () => {
  assert.equal(quizPackage.schemaVersion,1)
  assert.equal(quizPackage.workId,'peter-rabbit')
  assert.equal(quizPackage.pieceId,'peter-rabbit-01')
  assert.equal(quizPackage.contentVersion,1)
  assert.equal(quizPackage.quizVersion,1)
  assert.equal(quizPackage.questions.length,10)
})

test('local Quiz attempts store answers and are explicitly unverified', () => {
  const attempt=attempts.createLocalAttempt({quizPackage,book,selectedOptions:selectedOptions(),startedAt:'2026-09-23T01:00:00.000Z',submittedAt:'2026-09-23T01:05:00.000Z',attemptId:'local-test'})
  assert.equal(attempt.status,'local_unverified')
  assert.equal(attempt.score,100)
  assert.equal(attempt.mastery,true)
  assert.deepEqual(attempt.selectedOptions,selectedOptions())
  assert.equal(attempts.validate(attempt).valid,true)
  assert.equal(attempts.view(attempt).statusLabel,'本机练习 · 未服务端验证')
})

test('malformed attempts cannot enter the compatible report aggregate', () => {
  const malformed=makeAttempt('p1',90,'2026-09-23T01:00:00.000Z',{selectedOptions:[]})
  assert.equal(attempts.validate(malformed).valid,false)
  const summary=report.summarize([malformed],{p1:{contentVersion:1,quizVersion:1}})
  assert.equal(summary.history.length,1)
  assert.equal(summary.history[0].legacy,true)
  assert.equal(summary.latest.length,0)
})

test('local attempt creation rejects out-of-range answers', () => {
  const invalid=selectedOptions()
  invalid[0]=quizPackage.questions[0].options.length
  assert.throws(()=>attempts.createLocalAttempt({quizPackage,book,selectedOptions:invalid,startedAt:'2026-09-23T01:00:00.000Z'}),/Invalid Quiz answers/)
})

test('report preserves legacy history but excludes it from averages and trends', () => {
  const current=makeAttempt('p1',80,'2026-09-23T01:00:00.000Z')
  const summary=report.summarize([{id:7,title:'Old Quiz',score:100,date:'2026/9/1'},current],{p1:{contentVersion:1,quizVersion:1}})
  assert.equal(summary.history.length,2)
  assert.equal(summary.history[0].statusLabel,'旧版本机记录')
  assert.equal(summary.average,80)
  assert.equal(summary.trend.pieceCount,1)
})

test('report uses only the latest compatible attempt for each distinct piece', () => {
  const compatible={p1:{contentVersion:1,quizVersion:1}}
  const summary=report.summarize([
    makeAttempt('p1',20,'2026-09-23T01:00:00.000Z'),
    makeAttempt('p1',90,'2026-09-23T02:00:00.000Z'),
    makeAttempt('p1',100,'2026-09-23T03:00:00.000Z',{contentVersion:2})
  ],compatible)
  assert.equal(summary.history.length,3)
  assert.equal(summary.latest.length,1)
  assert.equal(summary.average,90)
})

test('trend requires six pieces and compares earliest and latest thirds', () => {
  const compatible={},results=[]
  for(let index=0;index<6;index++){
    const pieceId='p'+(index+1)
    compatible[pieceId]={contentVersion:1,quizVersion:1}
    results.push(makeAttempt(pieceId,50+index*10,`2026-09-${String(10+index).padStart(2,'0')}T01:00:00.000Z`))
  }
  const five=report.summarize(results.slice(0,5),compatible)
  assert.equal(five.trend.ready,false)
  assert.equal(five.trend.remaining,1)
  const six=report.summarize(results,compatible)
  assert.deepEqual(six.trend,{ready:true,remaining:0,early:55,recent:95,delta:40,pieceCount:6})
})

test('ranking UI exposes only honest unavailable state and supported periods', () => {
  const source=fs.readFileSync(path.join(__dirname,'..','miniprogram','ui','screen.wxml'),'utf8')
  const controller=fs.readFileSync(path.join(__dirname,'..','miniprogram','ui','controller.js'),'utf8')
  assert.match(source,/排行榜服务尚未开放|rankingStatusTitle/)
  assert.doesNotMatch(source,/A Campus|rank-self|rankFilter|rankingPeriod/)
  assert.doesNotMatch(controller,/campusOptions|weekOptions|monthOptions|gradeOptions|levelOptions/)
  assert.match(controller,/id:'seven'/)
  assert.match(controller,/id:'all'/)
  assert.deepEqual(ranking.states,['unauthenticated','unavailable','cohort_too_small','ready'])
  assert.equal(ranking.view('made_up').status,'unavailable')
})

test('completing the Peter quiz writes one versioned local attempt', () => {
  const previousWx=global.wx
  const stores={}
  global.wx={
    isBrowserPreview:true,
    __tingyueMode:'production',
    getStorageSync:key=>stores[key],
    setStorageSync:(key,value)=>{stores[key]=value},
    getWindowInfo:()=>({statusBarHeight:24}),
    showToast:()=>{}
  }
  try{
    const productMode=require('../miniprogram/config/product-mode')
    const { createPage }=require('../miniprogram/ui/controller')
    const page=createPage('quiz')
    page.setData=patch=>Object.assign(page.data,patch)
    page.onLoad({id:'peter-rabbit'})
    for(let index=0;index<quizPackage.questions.length;index++){
      page.answer({currentTarget:{dataset:{index:page.data.question.answer}}})
      page.nextQuestion()
      page.nextQuestion()
    }
    const saved=stores[productMode.PRODUCT_STORAGE_KEY].results[0]
    assert.equal(saved.pieceId,'peter-rabbit-01')
    assert.equal(saved.contentVersion,quizPackage.contentVersion)
    assert.equal(saved.quizVersion,quizPackage.quizVersion)
    assert.equal(saved.status,'local_unverified')
    assert.equal(saved.selectedOptions.length,10)
    assert.equal(page.data.quizResultStatus,'本机练习结果 · 未经服务端验证')
  }finally{global.wx=previousWx}
})
