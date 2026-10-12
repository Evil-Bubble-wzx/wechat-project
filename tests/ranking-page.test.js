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

test('ranking rejects stale list replies and records the exact returned snapshot filters',async()=>{
 let release,count=0;const pending=new Promise(done=>release=done);
 await stub({isAuthenticated:()=>true,rankings:async()=>++count===1?pending:{status:'ready',snapshotId:'00000000-0000-4000-8000-000000000002',cohortSize:10,minimumCohortSize:10,items:[{rank:1,participantId:'reader-001',metric:{value:'70'}}]}},async()=>{
  const view=page();view.setData({rankingCampuses:[{id:'a'}],rankingCampusIndex:0});
  const first=view.loadRankings();await view.loadRankings();release({status:'unavailable',items:[]});await first;
  assert.equal(view.data.rankingStatus,'ready');assert.equal(view.rankingScopeFilters.snapshotId,view.data.rankingSnapshotId);assert.equal(view.rankingScopeFilters.campusId,'a');
 });
});

test('ranking rejects a pagination response that changes the immutable snapshot',async()=>{
 await stub({isAuthenticated:()=>true,rankings:async()=>({snapshotId:'other',status:'ready',cohortSize:10,minimumCohortSize:10,items:[{participantId:'bad'}]})},async()=>{
  const view=page();view.setData({rankingCampuses:[{id:'a'}],rankingCampusIndex:0,rankingSnapshotId:'original',rankingItems:[{participantId:'keep'}]});await view.loadRankings('cursor');
  assert.equal(view.data.rankingStatus,'error');assert.deepEqual(view.data.rankingItems,[{participantId:'keep'}]);
 });
});
test('ranking list discards replies from the previous account',async()=>{
  const host=require('../miniprogram/services/host'),previous=host.accountScope()
  let userId='account-a',releaseList
  await stub({isAuthenticated:()=>true,currentUser:()=>({userId}),rankings:()=>new Promise(resolve=>{releaseList=resolve})},async()=>{
    try{
      host.setAccountScope(userId);const view=page();view.setData({rankingCampuses:[{id:'a'}],rankingCampusIndex:0,sheet:'rankingDetail'})
      const list=view.loadRankings()
      userId='account-b';host.setAccountScope(userId)
      releaseList({status:'ready',cohortSize:10,minimumCohortSize:10,currentUser:{participantId:'reader-a'},items:[{participantId:'reader-a'}]})
      await list
      assert.deepEqual(view.data.rankingItems,[]);assert.equal(view.data.rankingCurrentUser,null);assert.equal(view.data.rankingDetail,null)
    }finally{host.setAccountScope(previous)}
  })
})
