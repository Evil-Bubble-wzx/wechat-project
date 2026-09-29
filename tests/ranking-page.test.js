const test=require('node:test')
const assert=require('node:assert/strict')
const api=require('../miniprogram/services/api')
const {createPage}=require('../miniprogram/ui/controller')

function page() {
  const result=createPage('ranking')
  result.setData=patch=>Object.assign(result.data,patch)
  return result
}
const options={campuses:[{value:'campus-1',label:'一校区'}],periodTypes:[{value:'rolling7',label:'最近七天'},{value:'week',label:'周榜'}],periods:{week:[{key:'2026-W39',label:'第39周'}]},grades:[{value:'all',label:'全部'},{value:'3',label:'三年级'}],levels:[{value:'all',label:'全部'}]}
function stub(methods,run) {
  const original={}
  for(const [key,value] of Object.entries(methods)){original[key]=api[key];api[key]=value}
  return Promise.resolve().then(run).finally(()=>{for(const [key,value] of Object.entries(original))api[key]=value})
}

test('ranking requires authentication and explicit campus selection',async()=>{
  await stub({available:()=>true,isAuthenticated:()=>false},async()=>{const view=page();await view.loadRankingOptions();assert.equal(view.data.rankingStatus,'unauthenticated')})
  await stub({available:()=>true,isAuthenticated:()=>true,rankingOptions:async()=>options},async()=>{const view=page();await view.loadRankingOptions();assert.equal(view.data.rankingStatus,'choose_campus');assert.equal(view.data.rankingCampusIndex,-1);assert.equal(view.data.rankingTypes[0].id,'rolling7')})
})

test('ranking hides all entries under minimum cohort and uses backend filters',async()=>{
  let requested
  await stub({available:()=>true,isAuthenticated:()=>true,rankingOptions:async()=>options,rankings:async filters=>{requested=filters;return {status:'ready',cohortSize:2,minimumCohortSize:10,items:[{participantId:'should-hide'}]}}},async()=>{
    const view=page();await view.loadRankingOptions();view.setData({rankingCampusIndex:0});await view.loadRankings()
    assert.equal(requested.campusId,'campus-1');assert.equal(requested.periodType,'rolling7');assert.equal(requested.grade,'all')
    assert.equal(view.data.rankingStatus,'cohort_too_small');assert.deepEqual(view.data.rankingItems,[])
  })
})

test('ranking clears stale entries and exposes retryable network failure',async()=>{
  await stub({available:()=>true,isAuthenticated:()=>true,rankings:async()=>{throw new Error('offline')}},async()=>{
    const view=page()
    view.setData({rankingCampuses:[{id:'campus-1',label:'一校区'}],rankingCampusIndex:0,rankingItems:[{participantId:'stale'}]})
    await view.loadRankings()
    assert.equal(view.data.rankingStatus,'error')
    assert.deepEqual(view.data.rankingItems,[])
  })
})

test('ranking rejects stale replies and detail maps only anonymous summary fields',async()=>{
  let release
  const stale=new Promise(resolve=>{release=resolve})
  let count=0
  await stub({available:()=>true,isAuthenticated:()=>true,rankingOptions:async()=>options,rankings:async()=>++count===1?stale:{status:'ready',cohortSize:10,minimumCohortSize:10,items:[{rank:1,participantId:'reader-001',displayName:'读者01',metric:{value:88,unit:'分'}}]},rankingDetail:async()=>({participant:{participantId:'reader-001',displayName:'读者01'},rankingScore:88,scoreBreakdown:[],stats:{},quizzes:[{attemptId:'a1',title:'故事',correctPercent:80,selectedOptions:[1,2],phone:'secret'}]})},async()=>{
    const view=page();view.setData({rankingCampuses:[{id:'campus-1',label:'一校区'}],rankingCampusIndex:0})
    const first=view.loadRankings();const second=view.loadRankings();await second
    release({status:'unavailable',items:[]});await first
    assert.equal(view.data.rankingStatus,'ready');assert.equal(view.data.rankingItems.length,1)
    view.openRankingDetail({currentTarget:{dataset:{id:'reader-001'}}})
    await Promise.resolve();await Promise.resolve()
    assert.equal(view.data.rankingDetail.quizzes[0].correctPercent,80)
    assert.equal('selectedOptions' in view.data.rankingDetail.quizzes[0],false)
    assert.equal('phone' in view.data.rankingDetail.quizzes[0],false)
  })
})
