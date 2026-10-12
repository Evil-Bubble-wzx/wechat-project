const { books, questions, quizPackage } = require('../modules/catalog/books')
/* @demo-start */
const { demoLogin } = require('../modules/account/session')
const rules = require('../modules/physical-loan/rules')
const promotion = require('../modules/promotion/demo')
/* @demo-end */
const productMode = require('../config/product-mode')
const host = require('../services/host')
const api = require('../services/api')
const player = require('../modules/listen-read/player')
const cuesByBook = Object.assign({}, require('../modules/listen-read/cues-data'))
/* @demo-start */
Object.assign(cuesByBook,require('../modules/listen-read/legacy-cues-data'))
/* @demo-end */
const peterVocab = require('../modules/listen-read/peter-vocab-data')
/* @demo-start */
const legacyVocab = require('../modules/listen-read/legacy-vocab-data')
const legacyQuizzes = require('../modules/listen-read/legacy-quiz-data')
/* @demo-end */
const subtitles = require('../modules/listen-read/subtitles')
const contentNotices = require('../modules/content-notices')
const quizAttempts = require('../modules/quiz/attempts')
const reportAggregate = require('../modules/report/aggregate')
const cloudReport = require('../modules/report/cloud-view')
const localImport = require('../modules/sync/local-import')
const progressSync = require('../modules/sync/progress-sync')
const savedWordSync = require('../modules/sync/saved-word-sync')
const librarySync = require('../modules/sync/library-sync')
const quizSync = require('../modules/sync/quiz-sync')
const learningPoints = require('../modules/ranking/learning-points')
const rankingState = require('../modules/ranking/state')
const catalog = require('../modules/catalog/remote-catalog')
const remoteResources = require('../modules/catalog/remote-resources')
const defaults = () => ({ favorites:[], recent:[], progress:{}, results:[], words:[], savedWordEntries:{}, user:null, listeningSec:0, listenDaily:{} })
/* @demo-start */
const addDemoDefaults = state => {if(!Array.isArray(state.loans))state.loans=[];if(!Array.isArray(state.demoCoupons))state.demoCoupons=[];if(typeof state.demoInvitationCompleted!=='boolean')state.demoInvitationCompleted=false;if(!Array.isArray(state.demoPurchases))state.demoPurchases=[];return state}
/* @demo-end */
const pad2 = n => String(n).padStart(2,'0')
const fmtListening = total => { const s = Math.max(0, Math.floor(total || 0)); return s < 3600 ? pad2(Math.floor(s / 60)) + ':' + pad2(s % 60) : pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s % 3600 / 60)) }
/* @demo-start */
const fmtDate = timestamp => { const d = new Date(timestamp); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) }
const couponViews = (state, now = Date.now()) => (state.demoCoupons || []).map(coupon => Object.assign({}, coupon, {
  amountLabel:'¥' + coupon.amount,
  conditionLabel:'满 ¥' + coupon.minimum + ' 可用',
  expiresLabel:'有效期至 ' + fmtDate(coupon.expires),
  status:coupon.used ? 'Used' : coupon.expires <= now ? 'Expired' : 'Available',
  available:!coupon.used && coupon.expires > now
}))
/* @demo-end */
const tabs = [{id:'home',label:'Home',icon:'home'},{id:'recent',label:'Recent',icon:'play'},{id:'me',label:'Me',icon:'user'}]
const titles = { home:'Tingyue',library:'Find Books',me:'Me',detail:'Book Details',player:'Read for Me',recent:'Recent',report:'My Quizzes',ranking:'Rankings',login:'Welcome',quiz:'Take Quiz',notices:'内容来源与许可' }
/* @demo-start */
Object.assign(titles,{loans:'Borrowed',coupons:'My Coupons',invite:'Invite Friends'})
/* @demo-end */
const rankingTypes = []
const rankOption = item => ({id:String(item.value),label:String(item.label)})
const rankAll = [{id:'all',label:'全部'}]
const time = s => Math.floor(s/60).toString().padStart(2,'0') + ':' + Math.floor(s%60).toString().padStart(2,'0')
const developmentAudioErrorCode = error => {
  const match = String(error || '').match(/^(?:audio_error\s+)?(\d{1,8})(?::|\s|$)/)
  return match ? match[1] : '未知'
}
function playableBook(book, chapterId) {
  const chapter = (book.chapters || []).find(item => item.id === chapterId) || (!book.remote || !chapterId ? (book.chapters || [])[0] : null)
  if(book.remote&&chapterId&&!chapter)return Object.assign({},book,{chapterId,pieceId:chapterId,duration:0,localAudio:'',hasQuiz:false})
  return chapter ? Object.assign({}, book, { chapterId: chapter.id, pieceId:chapter.id, chapterTitle: chapter.title, duration: chapter.duration, localAudio: chapter.localAudio, hasQuiz: chapter.hasQuiz, contentVersion:chapter.contentVersion??book.contentVersion, quizVersion:chapter.quizVersion??book.quizVersion }) : book
}
function cueKey(book) { return book.chapterId || book.pieceId || book.id }
const findCue = (cues, milliseconds) => {
  let low=0,high=cues.length-1
  while(low<=high){const middle=Math.floor((low+high)/2),cue=cues[middle];if(milliseconds<cue.startMs)high=middle-1;else if(milliseconds>=cue.endMs)low=middle+1;else return cue}
  return high >= 0 ? cues[high] : null
}
function createPage(requestedRoute) {
  if(requestedRoute==='ranking-detail')return require('./ranking-detail').createPage()
  const policy=productMode.current()
  const isDemo=policy.isDemo
  let showAudioDiagnostic=false
  try { showAudioDiagnostic=wx.getAccountInfoSync?.().miniProgram?.envVersion==='develop' } catch (_) {}
  const routeAllowed=policy.allowsRoute(requestedRoute)
  const route=routeAllowed?requestedRoute:'home'
  let visibleBooks=isDemo?books:catalog.list()
  const firstBook=visibleBooks[0]||books.find(book=>policy.allowsBook(book.id))
  const ranking=rankingState.view('unavailable')
  const data={ route, title:titles[route], tabs, isTab:tabs.some(t=>t.id===route), inset:24, books:visibleBooks, featured:visibleBooks.slice(0,3), recommendations:visibleBooks.slice(0,2), book:firstBook, query:'',filter:'all', filters:[{id:'all',label:'All Books'},{id:'fiction',label:'Fiction'},{id:'nonfiction',label:'Nonfiction'},{id:'available',label:'Available'}], shown:visibleBooks, favorites:[], favoriteBooks:[], recent:[], readingList:[], recentMode:'recent', user:null, agreed:false, accountBusy:false, remoteContentStatus:'idle', syncStatus:'synced',syncStatusLabel:'学习进度已同步',syncPending:0,syncFailed:0, wordSyncStatus:'idle',wordSyncPending:0,wordSyncStatusLabel:'生词本待同步',savedWordItems:[],selectedWordSaved:false, sheet:'', playing:false, rate:1, position:0, formatted:'00:00',duration:time(firstBook.duration), subtitle:true, subtitleRows:[], subtitleStart:null, subtitleCurrent:-1, activeCue:null, selectedWord:{surface:'',phonetic:'—',partOfSpeech:'pending',definitionZh:'释义待审核',definitionEn:'This word is waiting for editorial review.',example:''}, loop:false, question:questions[0], questionIndex:0, answer:-1, checked:false, result:false, score:0, scores:[], quizTotal:questions.length, quizProgress:20, quizLabel:'THE TALE OF PETER RABBIT · 阅读小测', quizOptions:[], quizResultStatus:'', results:[], reportTrend:{ready:false,remaining:6,early:null,recent:null,delta:null,pieceCount:0}, localImportReady:false,localImportConsented:false,localImportBusy:false,localImportSummary:{progressPieces:0,words:0,quizAttempts:0,excluded:0},localImportErrors:[],localImportReceipt:null, learningPoints:'—',learningPointsLabel:'登录并同步后计入积分',rankingRuleSummary:'积分规则待服务端确认', rankingTypes, rankingType:'rolling7', rankingTypeLabel:'最近七天', rankingStatus:ranking.status, rankingStatusTitle:ranking.title, rankingStatusDescription:ranking.description, rankingCampuses:[],rankingCampusIndex:-1,rankingGrades:rankAll,rankingGradeIndex:0,rankingLevels:rankAll,rankingLevelIndex:0,rankingPeriods:[],rankingPeriodIndex:0,rankingItems:[],rankingCurrentUser:null,rankingNextCursor:null,rankingBusy:false,rankingDetail:null,rankingDetailStatus:'',rankingDetailNextCursor:null,rankingDetailBusy:false, reportSourceLabel:'本机练习记录',reportAsOf:'',listeningSourceLabel:'本机播放计时',quizSyncLabel:'Quiz 待同步',quizSyncPending:0,stats:{pieces:0,words:0,correct:0,correctLabel:'—',listening:'00:00'}, currentFavorite:false, isDemo, isProduction:!isDemo }
  data.showAudioDiagnostic=showAudioDiagnostic
  Object.assign(data,{librarySyncStatus:'idle',librarySyncLabel:'收藏与最近阅读仅保存在本机',librarySyncPending:0,catalogStatus:'local',catalogBusy:false,catalogNextCursor:null})
  data.audioDiagnostic=''
  data.playbackNotice=''
  /* @demo-start */
  Object.assign(data,{loanFilter:'all',loanTabs:[{id:'all',label:'All'},{id:'reserved',label:'Pending'},{id:'borrowed',label:'On Loan'},{id:'cancelled',label:'Cancelled'}],loanList:[],totalLoans:0,agreed:false,loginMethod:'wechat',phone:'',code:'',codeSent:false,coupons:[],couponCount:0,invitationClaimed:false,promoBooks:[],purchaseEligible:false,purchaseCompleted:false,purchasePrice:'¥15',purchaseDiscount:'¥0',purchaseTotal:'¥15',purchaseResult:null})
  /* @demo-end */
  return {
    data,
    onLoad(options) {if(!routeAllowed){host.go('home');return}const [bookId,chapterId]=((options&&options.id)||firstBook.id).split(':');const base=visibleBooks.find(b=>b.id===bookId)||(!isDemo&&api.isAuthenticated()&&api.dynamicCatalogAvailable()?{id:bookId,workId:bookId,title:'Loading…',duration:0,remote:true,chapters:[],words:null,pages:null}:firstBook);const book=route==='player'||route==='quiz'?playableBook(base,chapterId):base;this.setData({inset:host.inset(),book,duration:time(book.duration),contentNotices});if(route==='player'){const current=player.snapshot();if(current.pieceId!==cueKey(book)&&!book.remote)player.selectTrack(book);this.attachPlayer();this.syncPlayer(player.snapshot(),true)}if(route==='quiz')this.setupQuiz();this.refresh();if(!isDemo)this.wordSyncUnsubscribe=savedWordSync.subscribe(()=>this.refresh());this.loadRemote()},
    setupQuiz() {
      const book=this.data.book
      let selectedPackage=book.remote?(this.bundleCurrent()?this.remoteBundle.quiz:{schemaVersion:1,workId:book.workId,pieceId:cueKey(book),contentVersion:book.contentVersion,questions:[]}):quizPackage
      /* @demo-start */
      const formal=book.workId==='peter-rabbit'
      const legacyQuestions=(legacyQuizzes[book.chapterId]||[]).map((question,index)=>Object.assign({id:cueKey(book)+'-q'+(index+1)},question))
      if(isDemo&&!formal)selectedPackage={schemaVersion:1,workId:book.workId||book.id,pieceId:cueKey(book),contentVersion:book.contentVersion??null,quizVersion:1,mode:'fixed_order',masteryFeedbackPercent:80,questions:legacyQuestions}
      /* @demo-end */
      this.quizPackage=selectedPackage
      this.questions=this.quizPackage.questions||[]
      this.quizStartedAt=new Date().toISOString()
      this.selectedOptions=[]
      const question=this.questions[0]||null
      this.setData({question,questionIndex:0,answer:-1,checked:false,result:false,score:0,scores:[],quizResultStatus:'',quizTotal:this.questions.length,quizProgress:this.questions.length?100/this.questions.length:0,quizLabel:(book.chapterTitle||book.title)+' · 阅读小测',quizOptions:question?this.quizOptions(question):[]})
    },
    quizOptions(question) {return question.options.map((text,index)=>({text,index,letter:String.fromCharCode(65+index),audio:(question.audio||[])[index]||''}))},
    updateSubtitles(seconds, force) {
      const key=cueKey(this.data.book)
      const cues=this.cuesForBook()
      if(this.subtitleKey!==key){this.subtitleKey=key;this.subtitleLayout=subtitles.prepare(cues)}
      const view=subtitles.display(this.subtitleLayout,cues,Math.round(seconds*1000))
      if(force||view.start!==this.data.subtitleStart||view.current!==this.data.subtitleCurrent){this.setData({subtitleRows:view.rows,subtitleStart:view.start,subtitleCurrent:view.current,activeCue:view.current>=0?cues[view.current]:null})}
    },
    syncPlayer(session, force) {
      if(route!=='player'||session.pieceId!==cueKey(this.data.book)||session.accountScope!==host.accountScope())return
      if(this.data.book.remote&&session.book?.contentVersion!==this.data.book.contentVersion)return
      const duration=Number(session.duration)||Number(this.data.book.duration)||0
      const update={playing:session.status==='playing'||session.status==='loading'||session.status==='renewing',playbackStatus:session.status,position:session.position||0,formatted:time(session.position||0),duration:time(duration),rate:session.rate||1,loop:!!session.loop,audioDiagnostic:showAudioDiagnostic&&session.status==='error'?developmentAudioErrorCode(session.error):''}
      update.playbackNotice=session.sourceRenewing?(session.status==='paused'?'正在更新音频链接 · 保持暂停':'正在验证权限并更新音频链接…'):session.status==='error'?(session.pauseReason==='content_unavailable'?'本章版本或权限已变化，请重新打开本章':'音频恢复未完成，点击播放可重试'):''
      if(session.status==='error'&&session.pauseReason==='content_unavailable'&&this.data.book.remote){this.remoteBundle=null;update.remoteContentStatus='unavailable'}
      if(session.book)update.book=Object.assign({},this.data.book,session.book,{duration})
      Object.assign(update,learningPoints.view(host.read(),api.isAuthenticated()))
      this.setData(update)
      this.updateSubtitles(session.position||0,!!force)
      if(session.status==='error'&&this.lastPlayerError!==session.error){this.lastPlayerError=session.error;host.toast('音频加载失败，请稍后重试')}
    },
    attachPlayer() {if(route==='player'&&!this.playerUnsubscribe)this.playerUnsubscribe=player.subscribe(session=>this.syncPlayer(session,false))},
    detachPlayer() {if(this.playerUnsubscribe){this.playerUnsubscribe();this.playerUnsubscribe=null}this.wordResume=null},
    onShow() {this.refresh();if(route==='player'){this.attachPlayer();this.syncPlayer(player.snapshot(),true)}if(this.remoteLoadedOnce)this.loadRemote();if(!isDemo&&api.isAuthenticated()){void progressSync.activate();savedWordSync.foreground()}},
    onHide() {if(route==='player')player.saveNow();this.detachPlayer();if(!isDemo)progressSync.kick()},
    refresh() {
      this.state = Object.assign(defaults(),host.read())
      /* @demo-start */
      if(isDemo)addDemoDefaults(this.state)
      /* @demo-end */
      const s=this.state
      if(!isDemo)visibleBooks=catalog.list()
      if(!s.listeningSec&&Number(s.listeningSeconds)>0){s.listeningSec=Number(s.listeningSeconds);host.write(s)}
      this.stateBaseline=JSON.parse(JSON.stringify(s))
      const recent=s.recent.map(id=>visibleBooks.find(b=>b.id===id)).filter(Boolean)
      const pieces=Object.values(s.progress).filter(p=>p.completed).length
      const favoriteBooks=visibleBooks.filter(b=>s.favorites.includes(b.id))
      const readingList=this.data.recentMode==='favorites'?favoriteBooks:recent
      const compatiblePieces={}
      for(const book of visibleBooks){
        if(!book.remote&&book.workId==='peter-rabbit')compatiblePieces[book.pieceId||book.id]={contentVersion:quizPackage.contentVersion,quizVersion:quizPackage.quizVersion}
        for(const chapter of book.chapters||[])compatiblePieces[chapter.id]={contentVersion:chapter.contentVersion??book.contentVersion??null,quizVersion:chapter.quizVersion??(isDemo?1:null)}
      }
      const report=reportAggregate.summarize(s.results,compatiblePieces)
      const sync=progressSync.view(s)
      const wordSync=savedWordSync.status()
      const stableEntries=Object.values(s.savedWordEntries||{})
      const savedWordItems=[...stableEntries.map(entry=>Object.assign({key:entry.entryId,stable:true},entry)),...(s.words||[]).filter(surface=>!stableEntries.some(entry=>entry.surface===surface)).map(surface=>({key:'legacy:'+surface,surface,stable:false}))]
      const wordSyncStatusLabel=wordSync.status==='synced'?'生词本已同步':wordSync.status==='syncing'?'生词本同步中':wordSync.status==='error'?'生词本同步失败':wordSync.status==='pending'?'生词本待同步':'生词本未同步'
      const update={books:visibleBooks,featured:visibleBooks.slice(0,3),recommendations:visibleBooks.slice(0,2),...learningPoints.view(s,!isDemo&&api.isAuthenticated()),user:isDemo?null:api.currentUser(),favorites:s.favorites,favoriteBooks,readingList,savedWordItems,wordSyncStatus:wordSync.status,wordSyncPending:wordSync.pendingCount,wordSyncStatusLabel,recent,results:report.history,reportTrend:report.trend,currentFavorite:s.favorites.includes(this.data.book.id),syncStatus:sync.status,syncStatusLabel:sync.label,syncPending:sync.pending,syncFailed:sync.failed,stats:{pieces,words:visibleBooks.filter(b=>s.progress[cueKey(b)]?.completed).reduce((a,b)=>a+b.words,0),correct:report.average,correctLabel:report.latest.length?report.average+'%':'—',listening:fmtListening(s.listeningSec)}}
      const quizStatus=quizSync.status()
      update.quizSyncPending=quizStatus.pendingCount
      update.quizSyncLabel=quizStatus.status==='synced'?'Quiz 与云历史已同步':quizStatus.status==='syncing'?'Quiz 与云历史同步中':quizStatus.status==='error'?'Quiz 同步未完成，显示上次缓存':quizStatus.status==='local'?'云历史服务待升级':'Quiz 与云历史待同步'
      update.reportSourceLabel='本机练习记录 · 不计入正式排名'
      update.reportAsOf=''
      update.listeningSourceLabel='本机播放计时（含重复播放）'
      update.results=update.results.map(item=>Object.assign({},item,{scoreLabel:item.score+'%'}))
      if(!isDemo&&api.isAuthenticated())Object.assign(update,cloudReport.view(s))
      /* @demo-start */
      if(isDemo){
        const loanList=s.loans.map(l=>Object.assign({},l,{book:books.find(b=>b.id===l.bookId)})).filter(l=>l.book && (this.data.loanFilter==='all'||l.status===this.data.loanFilter))
        const coupons=couponViews(s),activeCoupons=coupons.filter(c=>c.available)
        const applicable=promotion.applicableCoupon(s,this.data.book.id)
        const purchaseCompleted=s.demoPurchases.includes(this.data.book.id)
        const promoBooks=books.filter(b=>promotion.eligibleBook(b.id)).map(b=>Object.assign({},b,{purchaseCompleted:s.demoPurchases.includes(b.id),priceLabel:'¥'+promotion.PRICE}))
        Object.assign(update,{user:s.user,loanList,totalLoans:s.loans.filter(l=>l.status!=='cancelled').length,coupons,couponCount:activeCoupons.length,invitationClaimed:!!s.demoInvitationCompleted,promoBooks,purchaseEligible:promotion.eligibleBook(this.data.book.id),purchaseCompleted,purchasePrice:'¥'+promotion.PRICE,purchaseDiscount:'¥'+(applicable?applicable.amount:0),purchaseTotal:'¥'+(promotion.PRICE-(applicable?applicable.amount:0))})
      }
      /* @demo-end */
      this.setData(update)
    },
    save() {const baseline=this.stateBaseline||{};const patch={};for(const key of new Set([...Object.keys(baseline),...Object.keys(this.state||{})]))if(JSON.stringify(baseline[key])!==JSON.stringify(this.state[key]))patch[key]=this.state[key];this.state=host.mutate(latest=>Object.assign(latest,patch));this.refresh()},
    nav(e) {host.go(e.currentTarget.dataset.page,e.currentTarget.dataset.id)},
    back() {host.back()},
    openBook(e) {host.go('detail',e.currentTarget.dataset.id)},
    inputSearch(e) {this.setData({query:e.detail.value,catalogNextCursor:null});if(!isDemo&&api.isAuthenticated()&&api.dynamicCatalogAvailable()){if(this.catalogSearchTimer)clearTimeout(this.catalogSearchTimer);this.catalogSearchTimer=setTimeout(()=>this.loadRemoteCatalog(),300)}else this.filterBooks()},
    search() {host.go('library')},
    chooseFilter(e) {this.setData({filter:e.currentTarget.dataset.id,catalogNextCursor:null});if(this.catalogSearchTimer){clearTimeout(this.catalogSearchTimer);this.catalogSearchTimer=null}this.filterBooks()},
    filterBooks() {if(!isDemo&&api.isAuthenticated()&&api.dynamicCatalogAvailable())return this.loadRemoteCatalog();const q=this.data.query.trim().toLowerCase(); const f=this.data.filter; this.setData({shown:visibleBooks.filter(b=>(f==='all'||(f==='available'?b.stock>0:b.category===f))&&[b.title,b.author,b.zh,b.editionLabel,b.series,b.internalContentNumber,b.number].some(v=>String(v).toLowerCase().includes(q)))})},
    requireUser() {
      /* @demo-start */
      if(isDemo&&!this.state.user){host.go('login');return false}
      /* @demo-end */
      return true
    },
    /* @demo-start */
    requireDemo() {if(isDemo)return true;host.toast('该功能仅在开发演示模式开放');return false},
    /* @demo-end */
    toggleFavorite() {
      if(!this.requireUser())return
      const id=this.data.book.id,action=this.data.currentFavorite?'unfavorite':'favorite'
      if(!isDemo&&api.isAuthenticated()){
        librarySync.activate(api.currentUser().userId,{sync:false})
        if(!librarySync.record(action,id)){host.toast('收藏服务暂不可用');return}
        this.refresh();host.toast(action==='favorite'?'已加入收藏 · 等待同步':'已取消收藏 · 等待同步');return
      }
      this.state.favorites=this.state.favorites.includes(id)?this.state.favorites.filter(x=>x!==id):[...this.state.favorites,id]
      this.save();host.toast(this.data.currentFavorite?'已加入收藏':'已取消收藏')
    },
    /* @demo-start */
    openReserve() {if(!this.requireDemo()||!this.requireUser())return;if(!this.data.book.stock){host.toast('暂无可借库存，可以先听读');return}this.setData({sheet:'reserve'})},
    confirmReserve() {if(!this.requireDemo())return;try{this.state.loans=rules.reserve(this.state.loans,this.data.book);this.save();this.setData({sheet:''});host.go('loans')}catch(e){host.toast(e.message)}},
    openPurchase() {if(!this.requireDemo()||!this.requireUser())return;if(!promotion.eligibleBook(this.data.book.id)){host.toast('这本书暂无购书演示');return}if(this.state.demoPurchases.includes(this.data.book.id)){host.toast('这本书已经完成演示购买');return}this.setData({sheet:'purchase'})},
    confirmPurchase() {if(!this.requireDemo())return;try{const result=promotion.simulatePurchase(this.state,this.data.book.id);this.save();this.setData({sheet:'purchaseResult',purchaseResult:{total:'¥'+result.total,couponUsed:result.couponUsed}})}catch(e){host.toast(e.message)}},
    claimInviteReward() {if(!this.requireDemo()||!this.requireUser())return;try{promotion.simulateInvitation(this.state);this.save();host.toast('¥5 优惠券已到账')}catch(e){host.toast(e.message)}},
    loanFilter(e) {this.setData({loanFilter:e.currentTarget.dataset.id});this.refresh()},
    cancelLoan(e) {if(!this.requireDemo())return;this.state.loans=this.state.loans.map(l=>l.id===e.currentTarget.dataset.id&&l.status==='reserved'?Object.assign({},l,{status:'cancelled',label:'已取消',due:'库存将在正式服务中释放'}):l);this.save();host.toast('演示预约已取消')},
    renewLoan(e) {if(!this.requireDemo())return;try{this.state.loans=this.state.loans.map(l=>l.id===e.currentTarget.dataset.id?rules.renew(l):l);this.save();host.toast('续借成功')}catch(e){host.toast(e.message)}},
    /* @demo-end */
    showSheet(e) {this.setData({sheet:e.currentTarget.dataset.sheet})},
    openLocalImport() {
      if(isDemo)return
      if(!api.isAuthenticated()){host.toast('请先登录微信账户');host.go('login');return}
      const guest=host.readGuest()
      const plan=localImport.prepareLocalImport({progress:guest.progress,words:guest.words,results:guest.results})
      this.localImportGuest=guest;this.localImportPlan=plan;this.localImportSession=localImport.createImportSession(plan)
      this.setData({sheet:'localImport',localImportReady:plan.ready,localImportConsented:false,localImportBusy:false,localImportSummary:plan.summary,localImportErrors:plan.errors,localImportErrorText:plan.errors.join('；'),localImportReceipt:null})
    },
    toggleLocalImportConsent() {if(!this.localImportSession||!this.data.localImportReady)return;if(this.data.localImportConsented)this.localImportSession.decline();else this.localImportSession.consent();this.setData({localImportConsented:!this.data.localImportConsented})},
    async submitLocalImport() {
      if(!this.localImportSession||!this.data.localImportConsented||this.data.localImportBusy)return
      const userId=api.currentUser()?.userId,session=this.localImportSession,guest=this.localImportGuest
      const stillCurrent=()=>!!userId&&api.isAuthenticated()&&api.currentUser()?.userId===userId&&host.accountScope()===userId&&this.localImportSession===session
      if(!stillCurrent())return
      this.setData({localImportBusy:true})
      try{
        const receipt=await session.submit(request=>api.localImport(request))
        if(!stillCurrent())return
        const results=new Map((receipt.items?.quizAttempts||[]).map(item=>[item.attemptId,item]))
        const imported=(guest?.results||[]).map(item=>{const result=results.get(item.attemptId);return result?Object.assign({},item,result):item})
        this.state=host.mutate(latest=>{
          const accountResults=new Map((latest.results||[]).map(item=>[item.attemptId,item]))
          for(const item of imported)accountResults.set(item.attemptId,item)
          latest.results=[...accountResults.values()]
          latest.localImportReceipts=[{snapshotId:receipt.snapshotId,acknowledgedAt:receipt.acknowledgedAt,summary:receipt.summary},...(latest.localImportReceipts||[]).filter(item=>item.snapshotId!==receipt.snapshotId)].slice(0,10)
          return latest
        })
        this.refresh();await progressSync.pullAll();if(!stillCurrent())return
        this.setData({localImportReceipt:receipt});this.refresh();host.toast(receipt.duplicate?'该批数据已导入':'本机学习数据已确认')
      }catch(_){if(stillCurrent())host.toast('导入失败，本机数据未丢失')}
      finally{if(stillCurrent())this.setData({localImportBusy:false})}
    },
    closeSheet() {const token=this.data.sheet==='word'&&this.wordResume;this.wordResume=null;this.setData({sheet:''});const current=player.snapshot();if(token&&token.sessionId===current.sessionId&&token.pieceId===current.pieceId&&current.status==='paused'&&current.pauseReason==='word')player.resume()},
    noop() {},
    agreement() {this.setData({agreed:!this.data.agreed})},
    /* @demo-start */
    loginMethod(e) {this.setData({loginMethod:e.currentTarget.dataset.id})},
    phoneInput(e) {this.setData({phone:e.detail.value})},
    codeInput(e) {this.setData({code:e.detail.value})},
    sendCode() {if(!this.requireDemo())return;if(!/^1\d{10}$/.test(this.data.phone)){host.toast('请输入 11 位手机号');return}this.setData({codeSent:true});host.toast('演示验证码：123456，未发送短信')},
    /* @demo-end */
    async login() {
      /* @demo-start */
      if(isDemo){try{this.state.user=demoLogin(this.data.loginMethod,this.data.phone,this.data.code,this.data.agreed);this.save();host.toast('已进入演示账户');host.back()}catch(e){host.toast(e.message)}return}
      /* @demo-end */
      if(!this.data.agreed){host.toast('请先阅读并同意用户协议和隐私政策');return}
      if(!api.available()){host.toast('账户服务暂不可用，请检查 API 地址');return}
      this.setData({accountBusy:true});player.pause('account_login')
      try{const user=await api.loginWechat();player.reloadScope();await progressSync.activate();savedWordSync.activate(user.userId);quizSync.foreground();this.refresh();host.toast('微信登录成功');host.back()}catch(_){host.toast('微信登录失败，请稍后重试')}finally{this.setData({accountBusy:false})}
    },
    async logout() {
      /* @demo-start */
      if(isDemo){this.state.user=null;this.save();this.setData({sheet:''});host.toast('已退出演示账户');return}
      /* @demo-end */
      this.localImportSession=null;this.localImportGuest=null;player.pause('logout')
      quizSync.deactivate();librarySync.deactivate();progressSync.deactivate();savedWordSync.deactivate();try{await api.logout()}catch(_){}player.reloadScope();this.refresh();this.setData({sheet:'',localImportBusy:false,localImportConsented:false,localImportReceipt:null});host.toast('已退出账户')
    },
    async retryProgressSync(){if(this.data.accountBusy)return;this.setData({accountBusy:true});try{await progressSync.retry();this.refresh();if(this.data.syncStatus==='synced')host.toast('学习进度已同步')}catch(_){host.toast('同步仍未完成，请稍后重试')}finally{this.setData({accountBusy:false})}},
    async retrySavedWordSync(){try{await savedWordSync.trigger('manual-retry',true);this.refresh();if(this.data.wordSyncStatus==='synced')host.toast('生词本已同步')}catch(_){host.toast('生词同步仍未完成，请稍后重试')}},
    async retryLibrarySync(){await librarySync.trigger('manual-retry',true);this.refresh();host.toast(librarySync.status().status==='synced'?'收藏与最近阅读已同步':'仍有记录待处理，请稍后重试')},
    recordRecent() {
      const id=this.data.book.id
      host.mutate(state=>{state.recent=[id,...(state.recent||[]).filter(value=>value!==id)].slice(0,30);return state})
      if(!isDemo&&api.isAuthenticated()){librarySync.activate(api.currentUser().userId,{sync:false});librarySync.record('open',id)}
      this.refresh()
    },
    startPlayer() {this.recordRecent();if(!this.data.book.remote)player.selectTrack(playableBook(this.data.book));else player.pause('selection');host.go('player',this.data.book.id)},
    startChapter(e) {const book=playableBook(this.data.book,e.currentTarget.dataset.id);this.recordRecent();if(!book.remote)player.selectTrack(book);else player.pause('selection');host.go('player',this.data.book.id+':'+e.currentTarget.dataset.id)},
    togglePlay() {
      if(this.data.playing){player.pause('user');return}
      const ok=player.playTrack(this.data.book)
      if(!ok)this.setData({sheet:'audio'})
    },
    seek(e) {const seconds=Number(e.detail.value);this.setData({position:seconds,formatted:time(seconds)});this.updateSubtitles(seconds,true);player.seek(seconds)},
    stepSentence(e) {const cues=this.cuesForBook();if(!cues.length)return;const delta=Number(e.currentTarget.dataset.step);const current=this.data.subtitleCurrent;const target=Math.max(0,Math.min(cues.length-1,Math.max(0,current)+delta));const seconds=cues[target].startMs/1000;this.setData({position:seconds,formatted:time(seconds)});this.updateSubtitles(seconds,true);player.seek(seconds)},
    speed() {const rates=[0.75,1,1.25,1.5,2];const rate=rates[(rates.indexOf(this.data.rate)+1)%rates.length];player.setRate(rate)},
    loop() {const loop=!this.data.loop;player.setLoop(loop);host.toast(loop?'单篇循环':'顺序播放')},
    toggleSubtitle() {this.setData({subtitle:!this.data.subtitle})},
    word(e) {const surface=e.currentTarget.dataset.word;const key=e.currentTarget.dataset.vocabKey||surface.toLowerCase();let entry=this.data.book.remote?(this.bundleCurrent()?this.remoteBundle.vocabulary[key]:null):peterVocab[key],garden=false;/* @demo-start */const formal=this.data.book.workId==='peter-rabbit';if(isDemo&&!formal){entry=legacyVocab[key];garden=surface.toLowerCase()==='garden'}/* @demo-end */const cues=this.cuesForBook();const cue=cues[Number(e.currentTarget.dataset.cueIndex)]||this.data.activeCue;const current=player.snapshot();this.wordResume=current.status==='playing'&&current.pieceId===cueKey(this.data.book)?{sessionId:current.sessionId,pieceId:current.pieceId}:null;if(this.wordResume)player.pause('word');const selectedWord={entryId:entry?.entryId||null,pieceId:cueKey(this.data.book),contentVersion:this.data.book.contentVersion||1,vocabKey:key,surface,lemma:entry?.lemma||surface.toLowerCase(),phonetic:entry?.phonetic||entry?.ph|| (garden?'/ˈɡɑːdn/':'—'),partOfSpeech:entry?.partOfSpeech||entry?.pos|| (garden?'noun':'待审核'),definitionZh:entry?.definitionZh||entry?.zh|| (garden?'花园；园子':'释义待审核'),definitionEn:entry?.definitionEn||entry?.en|| (garden?'A place where flowers, fruit, or vegetables grow.':'This word is waiting for editorial review.'),example:cue?cue.text:'',translation:cue?.translation||''};const selectedWordSaved=selectedWord.entryId?!!(this.state.savedWordEntries||{})[selectedWord.entryId]:(this.state.words||[]).includes(surface);this.setData({sheet:'word',selectedWord,selectedWordSaved})},
    saveWord() {if(!this.requireUser())return;const entry=this.data.selectedWord,word=entry.surface;this.state.words=[...new Set([...(this.state.words||[]),word])];if(entry.entryId)this.state.savedWordEntries=Object.assign({},this.state.savedWordEntries||{},{[entry.entryId]:{entryId:entry.entryId,pieceId:entry.pieceId,contentVersion:entry.contentVersion,vocabKey:entry.vocabKey,surface:entry.surface,lemma:entry.lemma}});this.save();if(!isDemo&&entry.entryId&&api.isAuthenticated())savedWordSync.saveWord(entry);this.setData({selectedWordSaved:true});host.toast(word+' 已加入生词本');this.closeSheet()},
    removeSelectedWord() {this.removeWordEntry(this.data.selectedWord)},
    removeSavedWord(e) {const key=e.currentTarget.dataset.key,item=(this.data.savedWordItems||[]).find(value=>value.key===key);if(item)this.removeWordEntry(item)},
    removeWordEntry(entry) {if(!entry||!entry.surface)return;const stable=Object.assign({},this.state.savedWordEntries||{});if(entry.entryId)delete stable[entry.entryId];this.state.savedWordEntries=stable;if(!Object.values(stable).some(item=>item.surface===entry.surface))this.state.words=(this.state.words||[]).filter(surface=>surface!==entry.surface);this.save();if(!isDemo&&entry.entryId&&api.isAuthenticated())savedWordSync.deleteWord(entry);this.setData({selectedWordSaved:false});host.toast(entry.surface+' 已移出生词本');if(this.data.sheet==='word')this.closeSheet()},
    nextTrack(e) {const step=Number(e.currentTarget.dataset.step);const current=this.data.book;const cached=catalog.get(current.id);const base=current.remote?(cached?.chapters?.length?cached:current):(visibleBooks.find(b=>b.id===current.id)||firstBook);const chapters=base.chapters||[];const index=chapters.findIndex(ch=>ch.id===current.chapterId);let book;if(chapters.length&&index+step>=0&&index+step<chapters.length)book=playableBook(base,chapters[index+step].id);else{const i=visibleBooks.findIndex(b=>b.id===current.id);book=playableBook(visibleBooks.length?visibleBooks[(i+step+visibleBooks.length)%visibleBooks.length]:base)}if(book.remote)player.pause('chapter_loading');else player.selectTrack(book);this.setData({book,duration:time(book.duration),position:0,formatted:'00:00',playing:false});this.remoteBundle=null;this.updateSubtitles(0,true);if(book.remote)return this.loadRemoteContent()},
    openQuiz() {const book=this.data.book;if(book.remote&&!(book.hasQuiz||(book.chapters||[])[0]?.hasQuiz)){host.toast('这一章暂时没有小测');return}const pieceId=book.chapterId||(book.chapters||[])[0]?.id;/* @demo-start */if(isDemo&&book.workId!=='peter-rabbit'&&!(legacyQuizzes[pieceId]||[]).length){host.toast('这一章暂时没有小测');return}/* @demo-end */this.wordResume=null;player.pause('quiz');host.go('quiz',book.id+(pieceId?':'+pieceId:''))},
    playOption(e) {const option=this.data.quizOptions[Number(e.currentTarget.dataset.index)];if(!option?.audio)return;player.pause('quiz_option');if(!this.optionAudio)this.optionAudio=wx.createInnerAudioContext();this.optionAudio.stop();this.optionAudio.src=option.audio;this.optionAudio.play()},
    onUnload() {if(this.catalogSearchTimer)clearTimeout(this.catalogSearchTimer);this.catalogEpoch=(this.catalogEpoch||0)+1;this.contentEpoch=(this.contentEpoch||0)+1;this.rankingEpoch=(this.rankingEpoch||0)+1;this.detachPlayer();if(this.wordSyncUnsubscribe)this.wordSyncUnsubscribe();if(this.librarySyncUnsubscribe)this.librarySyncUnsubscribe();if(this.quizSyncUnsubscribe)this.quizSyncUnsubscribe();if(this.optionAudio)this.optionAudio.destroy()},
    answer(e) {if(!this.data.checked)this.setData({answer:Number(e.currentTarget.dataset.index)})},
    nextQuestion() {if(!this.questions.length||!this.data.question)return;if(this.data.answer<0){host.toast('先选择一个答案吧');return}if(!this.data.checked){this.setData({checked:true});return}const scores=[...this.data.scores,this.data.answer===this.data.question.answer?1:0];this.selectedOptions[this.data.questionIndex]=this.data.answer;const n=this.data.questionIndex+1;if(n>=this.questions.length){const attempt=quizAttempts.createLocalAttempt({quizPackage:this.quizPackage,book:this.data.book,selectedOptions:this.selectedOptions,startedAt:this.quizStartedAt});this.state.results=[attempt,...this.state.results];this.save();this.setData({result:true,score:attempt.score,scores,quizResultStatus:'本机练习结果 · 未经服务端验证'});this.submitQuizAttempt(attempt)}else{const question=this.questions[n];this.setData({questionIndex:n,question,quizOptions:this.quizOptions(question),quizProgress:(n+1)/this.questions.length*100,answer:-1,checked:false,scores})}},
    async submitQuizAttempt(attempt) {
      if(!api.available()||!api.isAuthenticated())return
      const userId=api.currentUser()?.userId
      const stillCurrent=()=>!!userId&&api.isAuthenticated()&&api.currentUser()?.userId===userId&&host.accountScope()===userId
      if(!stillCurrent())return
      this.currentQuizAttemptId=attempt.attemptId
      if(!quizSync.activate(userId,{sync:false})||!quizSync.enqueue(attempt,false)){
        this.setData({quizResultStatus:'未能加入补传队列 · 原始练习记录仍在本机'});return
      }
      await quizSync.trigger('submit',true)
      if(stillCurrent()){this.refresh();this.syncQuizFeedback()}
    },
    syncQuizFeedback(){
      if(!this.currentQuizAttemptId)return
      const result=(host.read().results||[]).find(item=>item.attemptId===this.currentQuizAttemptId)
      if(!result)return
      const label=result.status==='server_verified'?'服务端已验证 · 已计入可信统计':result.status==='rejected'?'服务端未接受或已撤回 · 本机答案保留':'等待补传 · 原始答案已按账号保存在本机'
      this.setData({score:result.score??this.data.score,quizResultStatus:label})
    },
    activateQuizSync(){
      if(isDemo||!api.available()||!api.isAuthenticated())return
      if(!this.quizSyncUnsubscribe)this.quizSyncUnsubscribe=quizSync.subscribe(()=>{this.refresh();this.syncQuizFeedback()})
      quizSync.activate(api.currentUser().userId,{sync:false})
    },
    async retryQuizSync(){await quizSync.trigger('manual-retry',true);this.refresh();this.syncQuizFeedback()},
    retryQuiz() {this.setupQuiz()},
    activateLibrarySync() {
      if(isDemo||!api.available()||!api.isAuthenticated())return
      if(!this.librarySyncUnsubscribe)this.librarySyncUnsubscribe=librarySync.subscribe(()=>{const sync=librarySync.status();const label=sync.status==='synced'?'收藏与最近阅读已同步':sync.status==='syncing'?'收藏与最近阅读同步中':sync.status==='attention'?'部分收藏被服务端保留或拒绝，请检查书目':sync.status==='error'?'收藏与最近阅读同步失败':'收藏与最近阅读待同步';this.setData({librarySyncStatus:sync.status,librarySyncLabel:label,librarySyncPending:sync.pendingCount});this.refresh()})
      librarySync.foreground()
    },
    async loadRemote() {
      this.remoteLoadedOnce=true
      if(isDemo)return
      this.activateLibrarySync()
      if(route==='ranking'){await this.loadLearningScore();await this.loadRankingOptions();return}
      if(!api.available()||!api.isAuthenticated())return
      this.activateQuizSync()
      if(['me','report'].includes(route))await quizSync.trigger('page',true)
      if(['home','library','recent','me'].includes(route)&&api.dynamicCatalogAvailable())await this.loadRemoteCatalog()
      await this.loadLearningScore()
      if(['detail','player','quiz'].includes(route))await this.loadRemoteContent()
    },
    async loadLearningScore(){
      if(!api.available()||!api.isAuthenticated()||typeof api.learningScore!=='function')return
      const userId=api.currentUser()?.userId
      try{const summary=await api.learningScore();if(userId&&api.currentUser()?.userId===userId&&host.accountScope()===userId){host.mutate(state=>learningPoints.applyConfirmed(state,summary));this.refresh()}}catch(_){/* A failed score read must not erase confirmed points. */}
    },
    bundleCurrent() {const b=this.data.book;return !!(this.remoteBundle&&this.remoteBundle.workId===(b.workId||b.id)&&this.remoteBundle.pieceId===cueKey(b)&&this.remoteBundle.contentVersion===b.contentVersion)},
    cuesForBook() {return this.data.book.remote?(this.bundleCurrent()?this.remoteBundle.cues:[]):cuesByBook[cueKey(this.data.book)]||[]},
    async loadRemoteCatalog(cursor) {
      if(isDemo||!api.available()||!api.isAuthenticated()||!api.dynamicCatalogAvailable())return
      const userId=api.currentUser()?.userId,epoch=this.catalogEpoch=(this.catalogEpoch||0)+1
      const filters={query:route==='library'?this.data.query:'',category:route==='library'?this.data.filter:'all'}
      const current=()=>this.catalogEpoch===epoch&&api.isAuthenticated()&&api.currentUser()?.userId===userId&&host.accountScope()===userId&&(route!=='library'||(this.data.query===filters.query&&this.data.filter===filters.category))
      catalog.setScope(userId);this.setData({catalogBusy:true,catalogStatus:'loading'})
      try{
        const response=await api.listWorks(cursor,50,filters)
        if(!current())return
        if(cursor)catalog.append(response,userId);else catalog.replace(response,userId,!!filters.query||filters.category!=='all')
        const incoming=response.items.map(catalog.fromSummary)
        const shown=cursor?[...new Map([...(this.data.shown||[]),...incoming].map(book=>[book.id,book])).values()]:incoming
        visibleBooks=catalog.list()
        this.setData({books:visibleBooks,shown,featured:visibleBooks.slice(0,3),recommendations:visibleBooks.slice(0,2),catalogStatus:'ready',catalogNextCursor:response.nextCursor})
        if(['recent','me'].includes(route)){
          const state=host.read(),ids=[...new Set([...(state.favorites||[]),...(state.recent||[])])]
          for(const id of ids.slice(0,100)){if(!current())return;if(catalog.has(id))continue;try{const work=await api.getWork(id);if(current())catalog.putWork(work,userId)}catch(_){}}
        }
        if(current())this.refresh()
      }catch(_){if(current())this.setData({catalogStatus:'error'})}
      finally{if(current())this.setData({catalogBusy:false})}
    },
    moreCatalog(){if(this.data.catalogNextCursor&&!this.data.catalogBusy)return this.loadRemoteCatalog(this.data.catalogNextCursor)},
    retryCatalog(){return this.loadRemoteCatalog()},
    retryContent(){return this.loadRemoteContent()},
    onReachBottom(){if(route==='home'||route==='library')return this.moreCatalog()},
    async loadRemoteContent() {
      const userId=api.currentUser()?.userId,wanted=cueKey(this.data.book),workId=this.data.book.workId||this.data.book.id
      const epoch=this.contentEpoch=(this.contentEpoch||0)+1
      let selectedPiece=wanted
      const current=()=>epoch===this.contentEpoch&&api.isAuthenticated()&&api.currentUser()?.userId===userId&&host.accountScope()===userId&&(this.data.book.workId||this.data.book.id)===workId&&cueKey(this.data.book)===selectedPiece
      this.setData({remoteContentStatus:'loading'})
      try{
        const response=await api.getWork(workId)
        if(!current())return
        let base=this.data.book
        if(api.dynamicCatalogAvailable()){catalog.setScope(userId);base=catalog.putWork(response,userId)}
        const target=this.data.book.chapterId||this.data.book.pieceId
        const piece=(response.pieces||[]).find(item=>item.pieceId===(target||wanted))||(!target?(response.pieces||[])[0]:null)
        if(!piece){this.remoteBundle=null;this.setData({remoteContentStatus:'unavailable'});return}
        selectedPiece=piece.pieceId
        const book=playableBook(base,piece.pieceId)
        if(route==='player'&&book.remote&&player.snapshot().pieceId===piece.pieceId&&player.snapshot().book?.contentVersion!==piece.currentContentVersion)player.pause('content_version_changed')
        this.setData({book,duration:time(book.duration)})
        if(route==='detail'){this.setData({remoteContentStatus:'ready'});this.refresh();return}
        const manifest=await api.getManifest(piece.pieceId,piece.currentContentVersion)
        if(!current())return
        if(api.dynamicCatalogAvailable()){
          const bundle=await remoteResources.loadBundle(manifest,{workId,pieceId:piece.pieceId,contentVersion:piece.currentContentVersion})
          if(!current())return
          const sameQuiz=this.quizPackage?.workId===bundle.workId&&this.quizPackage?.pieceId===bundle.pieceId&&this.quizPackage?.contentVersion===bundle.contentVersion&&this.quizPackage?.quizVersion===bundle.quizVersion&&this.questions?.length
          this.remoteBundle=bundle;this.subtitleKey=null
          const ready=Object.assign({},book,{pieceId:bundle.pieceId,contentVersion:bundle.contentVersion,quizVersion:bundle.quizVersion,localAudio:bundle.audioUrl,cover:bundle.coverUrl,duration:bundle.duration,remoteManifest:manifest,audioAccountScope:userId,remote:true,hasQuiz:true})
          this.setData({book:ready,duration:time(ready.duration),remoteContentStatus:'ready'})
          if(route==='quiz'&&!sameQuiz)this.setupQuiz()
          if(route==='player'){
            try{await progressSync.pullPiece(piece.pieceId)}catch(_){/* Resource availability is independent of a failed progress read. */}
            if(!current())return
            player.selectTrack(ready);this.syncPlayer(player.snapshot(),true)
          }
        }else{
          const audio=(manifest.assets||[]).find(asset=>asset.type==='audio'),cover=(manifest.assets||[]).find(asset=>asset.type==='cover')
          const ready=Object.assign({},book,{workId:manifest.workId,pieceId:manifest.pieceId,contentVersion:manifest.contentVersion,quizVersion:manifest.quizVersion,localAudio:audio?.url||book.localAudio,cover:cover?.url||book.cover,remoteManifest:manifest,audioAccountScope:userId})
          this.setData({book:ready,remoteContentStatus:'ready'})
          if(route==='player'&&audio?.url){
            try{await progressSync.pullPiece(piece.pieceId)}catch(_){}
            if(!current())return
            player.selectTrack(ready);this.syncPlayer(player.snapshot(),true)
          }
        }
        if(route!=='player')await progressSync.pullPiece(piece.pieceId)
      }catch(error){if(current()){const denied=['RESOURCE_NOT_FOUND','CONTENT_ACCESS_DENIED','CONTENT_VERSION_UNAVAILABLE'].includes(error?.serverCode);if(denied||!this.bundleCurrent())this.remoteBundle=null;if(denied&&route==='player')player.pause('content_unavailable');this.setData({remoteContentStatus:'unavailable'});if(this.data.book.remote&&route==='quiz'&&!this.bundleCurrent())this.setupQuiz()}}
    },
    chooseRecentMode(e) {const recentMode=e.currentTarget.dataset.id;this.setData({recentMode,readingList:recentMode==='favorites'?this.data.favoriteBooks:this.data.recent})},
    setRankingStatus(status) {const value=rankingState.view(status);this.setData({rankingStatus:value.status,rankingStatusTitle:value.title,rankingStatusDescription:value.description})},
    rankingRequestCurrent(userId,key,epoch) {return this[key]===epoch&&api.isAuthenticated()&&(api.currentUser()?.userId||null)===userId&&(!userId||host.accountScope()===userId)},
    async loadRankingOptions() {
      const epoch=this.rankingEpoch=(this.rankingEpoch||0)+1
      const userId=api.currentUser()?.userId||null
      const stillCurrent=()=>this.rankingRequestCurrent(userId,'rankingEpoch',epoch)
      if(!api.available()){this.setRankingStatus('unavailable');return}
      if(!api.isAuthenticated()){this.setRankingStatus('unauthenticated');return}
      this.setRankingStatus('loading')
      try {
        const options=await api.rankingOptions()
        if(!stillCurrent())return
        const campuses=(options.campuses||[]).map(rankOption),types=(options.periodTypes||[]).map(rankOption)
        const returned=this.data.rankingCampusIndex<0?require('./ranking-detail').returnFilters(userId):null
        const type=types.find(item=>item.id===(returned?.periodType||this.data.rankingType))||types.find(item=>item.id==='rolling7')||types[0]
        const campusIndex=campuses.findIndex(item=>item.id===(returned?.campusId||this.data.rankingCampuses[this.data.rankingCampusIndex]?.id))
        const grades=[...rankAll,...(options.grades||[]).filter(item=>item.value!=='all').map(rankOption)]
        const levels=[...rankAll,...(options.levels||[]).filter(item=>item.value!=='all').map(rankOption)]
        this.rankingOptions=options
        this.setData({rankingRuleSummary:learningPoints.ruleText(options.scoreRules),rankingTypes:types,rankingType:type?.id||'',rankingTypeLabel:type?.label||'',rankingCampuses:campuses,rankingCampusIndex:campusIndex,rankingGrades:grades,rankingGradeIndex:Math.max(0,grades.findIndex(item=>item.id===(returned?.grade||this.data.rankingGrades[this.data.rankingGradeIndex]?.id))),rankingLevels:levels,rankingLevelIndex:Math.max(0,levels.findIndex(item=>item.id===(returned?.level||this.data.rankingLevels[this.data.rankingLevelIndex]?.id)))})
        this.updateRankingPeriods()
        const previousPeriod=returned?.periodKey||this.rankingScopeFilters?.periodKey
        if(previousPeriod)this.setData({rankingPeriodIndex:Math.max(0,this.data.rankingPeriods.findIndex(item=>item.id===previousPeriod))})
        if(!campuses.length)this.setRankingStatus('unavailable')
        else if(campusIndex<0)this.setRankingStatus('choose_campus')
        else await this.loadRankings()
      }catch(_){if(stillCurrent())this.setRankingStatus('error')}
    },
    updateRankingPeriods() {const periods=((this.rankingOptions||{}).periods||{})[this.data.rankingType]||[];this.setData({rankingPeriods:periods.map(item=>({id:item.key,label:item.label})),rankingPeriodIndex:0})},
    rankingFilters(cursor) {return {campusId:this.data.rankingCampuses[this.data.rankingCampusIndex]?.id,periodType:this.data.rankingType,periodKey:this.data.rankingPeriods[this.data.rankingPeriodIndex]?.id,grade:this.data.rankingGrades[this.data.rankingGradeIndex]?.id||'all',level:this.data.rankingLevels[this.data.rankingLevelIndex]?.id||'all',cursor,limit:50}},
    async loadRankings(cursor) {
      const filters=this.rankingFilters(cursor)
      if(!filters.campusId){this.setRankingStatus('choose_campus');return}
      const epoch=cursor?this.rankingEpoch:(this.rankingEpoch=(this.rankingEpoch||0)+1)
      const userId=api.currentUser()?.userId||null
      const stillCurrent=()=>this.rankingRequestCurrent(userId,'rankingEpoch',epoch)
      if(this.data.rankingBusy&&cursor)return
      this.setData({rankingBusy:true,...(!cursor?{rankingItems:[],rankingNextCursor:null,rankingCurrentUser:null,rankingSnapshotId:null}:{})})
      if(!cursor)this.setRankingStatus('loading')
      try {
        const response=await api.rankings(filters)
        if(!stillCurrent())return
        const status=response.status==='ready'&&response.cohortSize>=response.minimumCohortSize?'ready':response.status==='cohort_too_small'||response.status==='ready'?'cohort_too_small':'unavailable'
        if(status!=='ready'){this.setData({rankingItems:[],rankingCurrentUser:null,rankingNextCursor:null});this.setRankingStatus(status);return}
        if(cursor&&this.data.rankingSnapshotId&&response.snapshotId!==this.data.rankingSnapshotId)throw new Error('ranking_snapshot_changed')
        this.rankingScopeFilters=Object.assign({},filters,{cursor:undefined,snapshotId:response.snapshotId||null});this.rankingDataOwner=userId
        const items=(response.items||[]).map(item=>({rank:item.rank,participantId:item.participantId,displayName:item.displayName,gradeLabel:item.gradeLabel,readingLevelLabel:item.readingLevelLabel,score:learningPoints.formatPoints(item.metric?.value),scoreUnit:'分'}))
        const previous=cursor?this.data.rankingItems:[]
        const ids=new Set(previous.map(item=>item.participantId))
        this.setData({rankingSnapshotId:response.snapshotId||null,rankingItems:[...previous,...items.filter(item=>!ids.has(item.participantId))],rankingNextCursor:response.nextCursor||null,rankingCurrentUser:response.currentUser?Object.assign({},response.currentUser,{pointsLabel:learningPoints.formatPoints(response.currentUser.metric?.value)}):null})
        this.setRankingStatus('ready')
      }catch(_){if(stillCurrent())this.setRankingStatus('error')}
      finally{if(stillCurrent())this.setData({rankingBusy:false})}
    },
    chooseRankingType(e) {const option=this.data.rankingTypes.find(item=>item.id===e.currentTarget.dataset.id);if(!option)return;this.setData({rankingType:option.id,rankingTypeLabel:option.label});this.updateRankingPeriods();this.loadRankings()},
    chooseRankingCampus(e) {this.setData({rankingCampusIndex:Number(e.detail.value)});this.loadRankings()},
    chooseRankingGrade(e) {this.setData({rankingGradeIndex:Number(e.detail.value)});this.loadRankings()},
    chooseRankingLevel(e) {this.setData({rankingLevelIndex:Number(e.detail.value)});this.loadRankings()},
    chooseRankingPeriod(e) {this.setData({rankingPeriodIndex:Number(e.detail.value)});this.loadRankings()},
    retryRanking() {this.loadRankingOptions()},
    moreRankings() {if(this.data.rankingNextCursor&&!this.data.rankingBusy)this.loadRankings(this.data.rankingNextCursor)},
    openRankingDetail(e) {const id=e.currentTarget.dataset.id,userId=api.currentUser()?.userId;if(!id||this.data.rankingStatus!=='ready'||!this.data.rankingSnapshotId||!userId||this.rankingDataOwner!==userId||host.accountScope()!==userId)return false;return require('./ranking-detail').navigate(Object.assign({},this.rankingScopeFilters,{participantId:id}))},
    noopRanking() {}
  }
}
module.exports = { createPage, getProductPolicy:productMode.current }
