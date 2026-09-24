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
const rankingState = require('../modules/ranking/state')
const rankingModel = require('../modules/ranking/model')
const defaults = () => ({ favorites:[], recent:[], progress:{}, results:[], user:null, listeningSec:0, listenDaily:{} })
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
const titles = { home:'Tingyue',library:'Find Books',me:'Me',detail:'Book Details',player:'Read for Me',recent:'Recent',report:'My Quizzes',ranking:'Rankings','ranking-detail':'Quiz Details',login:'Welcome',quiz:'Take Quiz',notices:'内容来源与许可' }
/* @demo-start */
Object.assign(titles,{loans:'Borrowed',coupons:'My Coupons',invite:'Invite Friends'})
/* @demo-end */
const rankingTypes = [
  {id:'seven',label:'7-Day',description:'Rolling last 7 days'},
  {id:'week',label:'Weekly',description:'Strict calendar week'},
  {id:'month',label:'Monthly',description:'Calendar month'},
  {id:'year',label:'Yearly',description:'Calendar year'}
]
const campusOptions = [{id:'a',label:'A Campus'},{id:'b',label:'B Campus'}]
const gradeOptions = [{id:'all',label:'All Grades'},{id:'k',label:'Kindergarten'},...Array.from({length:9},(_,i)=>({id:String(i+1),label:'Grade '+(i+1)}))]
const levelOptions = [{id:'all',label:'All Levels'},...Array.from({length:5},(_,i)=>({id:String(i+1),label:'Lv '+(i+1)+'.x'}))]
const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
const shortDate = date => pad2(date.getMonth()+1)+'/'+pad2(date.getDate())
const dateKey = date => date.getFullYear()+'-'+pad2(date.getMonth()+1)+'-'+pad2(date.getDate())
function isoWeek(date) {
  const target=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()))
  const day=target.getUTCDay()||7
  target.setUTCDate(target.getUTCDate()+4-day)
  const year=target.getUTCFullYear(),yearStart=new Date(Date.UTC(year,0,1))
  return {year,week:Math.ceil((((target-yearStart)/86400000)+1)/7)}
}
function weekOptionsFrom(base=new Date()) {
  const monday=new Date(base);monday.setHours(12,0,0,0);monday.setDate(monday.getDate()-((monday.getDay()+6)%7))
  return Array.from({length:12},(_,index)=>{
    const start=new Date(monday);start.setDate(start.getDate()-index*7)
    const end=new Date(start);end.setDate(end.getDate()+6)
    const value=isoWeek(start)
    return {id:value.year+'-W'+pad2(value.week),label:value.year+' · Week '+value.week,description:shortDate(start)+'–'+shortDate(end),startDate:dateKey(start),endDate:dateKey(end)}
  })
}
function monthOptionsFrom(base=new Date()) {
  return Array.from({length:12},(_,index)=>{
    const date=new Date(base.getFullYear(),base.getMonth()-index,1),year=date.getFullYear(),month=date.getMonth()+1
    return {id:year+'-'+pad2(month),label:year+' · '+pad2(month),description:monthNames[month-1]+' '+year}
  })
}
const time = s => Math.floor(s/60).toString().padStart(2,'0') + ':' + Math.floor(s%60).toString().padStart(2,'0')
function playableBook(book, chapterId) {
  const chapter = (book.chapters || []).find(item => item.id === chapterId) || (book.chapters || [])[0]
  return chapter ? Object.assign({}, book, { chapterId: chapter.id, chapterTitle: chapter.title, duration: chapter.duration, localAudio: chapter.localAudio, hasQuiz: chapter.hasQuiz }) : book
}
function cueKey(book) { return book.chapterId || book.pieceId || book.id }
const findCue = (cues, milliseconds) => {
  let low=0,high=cues.length-1
  while(low<=high){const middle=Math.floor((low+high)/2),cue=cues[middle];if(milliseconds<cue.startMs)high=middle-1;else if(milliseconds>=cue.endMs)low=middle+1;else return cue}
  return high >= 0 ? cues[high] : null
}
function createPage(requestedRoute) {
  const policy=productMode.current()
  const isDemo=policy.isDemo
  const routeAllowed=policy.allowsRoute(requestedRoute)
  const route=routeAllowed?requestedRoute:'home'
  const visibleBooks=isDemo?books:books.filter(book=>policy.allowsBook(book.id))
  const firstBook=visibleBooks[0]
  const ranking=rankingState.view('unavailable')
  const weekOptions=weekOptionsFrom(),monthOptions=monthOptionsFrom(),selectedWeek=weekOptions[0],selectedMonth=monthOptions[0]
  const emptyRankingDetail=rankingModel.normalizeDetail()
  const data={ route, title:titles[route], tabs, isTab:tabs.some(t=>t.id===route), inset:24, books:visibleBooks, featured:visibleBooks.slice(0,3), recommendations:visibleBooks.slice(0,2), book:firstBook, query:'',filter:'all', filters:[{id:'all',label:'All Books'},{id:'fiction',label:'Fiction'},{id:'nonfiction',label:'Nonfiction'},{id:'available',label:'Available'}], shown:visibleBooks, favorites:[], favoriteBooks:[], recent:[], readingList:[], recentMode:'recent', user:null, agreed:false, accountBusy:false, remoteCatalogStatus:'idle', sheet:'', playing:false, rate:1, position:0, formatted:'00:00',duration:time(firstBook.duration), subtitle:true, subtitleRows:[], subtitleStart:null, subtitleCurrent:-1, activeCue:null, selectedWord:{surface:'',phonetic:'—',partOfSpeech:'pending',definitionZh:'释义待审核',definitionEn:'This word is waiting for editorial review.',example:''}, loop:false, question:questions[0], questionIndex:0, answer:-1, checked:false, result:false, score:0, scores:[], quizTotal:questions.length, quizProgress:20, quizLabel:'THE TALE OF PETER RABBIT · 阅读小测', quizOptions:[], quizResultStatus:'', results:[], reportTrend:{ready:false,remaining:6,early:null,recent:null,delta:null,pieceCount:0}, campusOptions,campus:'a',campusLabel:'A Campus',rankingTypes,rankingType:'seven',rankingTypeLabel:'7-Day',weekOptions,monthOptions,selectedWeek:selectedWeek.id,selectedWeekLabel:selectedWeek.label,selectedMonth:selectedMonth.id,selectedMonthLabel:selectedMonth.label,gradeOptions,levelOptions,rankGrade:'all',rankGradeLabel:'All Grades',rankLevel:'all',rankLevelLabel:'All Levels',rankingStatus:ranking.status, rankingStatusTitle:ranking.title, rankingStatusDescription:ranking.description, rankingMetricLabel:rankingModel.METRIC_LABEL, rankingEntries:[], rankingRangeLabel:'', rankingRuleVersion:'', rankingDetail:emptyRankingDetail, rankingQuizQuery:'', rankingQuizSort:'takenAt', rankingQuizSortLabel:rankingModel.sortOptions[0].label, rankingQuizSortOptions:rankingModel.sortOptions, rankingQuizRows:[], stats:{pieces:0,words:0,correct:0,correctLabel:'—',listening:'00:00'}, currentFavorite:false, isDemo, isProduction:!isDemo }
  data.rankingStartsAt=null
  data.rankingEndsAt=null
  /* @demo-start */
  Object.assign(data,{loanFilter:'all',loanTabs:[{id:'all',label:'All'},{id:'reserved',label:'Pending'},{id:'borrowed',label:'On Loan'},{id:'cancelled',label:'Cancelled'}],loanList:[],totalLoans:0,agreed:false,loginMethod:'wechat',phone:'',code:'',codeSent:false,coupons:[],couponCount:0,invitationClaimed:false,promoBooks:[],purchaseEligible:false,purchaseCompleted:false,purchasePrice:'¥15',purchaseDiscount:'¥0',purchaseTotal:'¥15',purchaseResult:null})
  /* @demo-end */
  return {
    data,
    onLoad(options) {if(!routeAllowed){host.go('home');return}const [bookId,chapterId]=((options&&options.id)||firstBook.id).split(':');const base=visibleBooks.find(b=>b.id===bookId)||firstBook;const book=route==='player'||route==='quiz'?playableBook(base,chapterId):base;this.remoteParticipantId=options&&options.id;this.setData({inset:host.inset(),book,duration:time(book.duration),contentNotices});if(route==='player'){const current=player.snapshot();if(current.pieceId!==cueKey(book))player.selectTrack(book);this.attachPlayer();this.syncPlayer(player.snapshot(),true)}if(route==='quiz')this.setupQuiz();if(route==='ranking-detail')this.setupRankingDetail(this.remoteParticipantId);this.refresh();this.loadRemote()},
    setupRankingDetail(participantId) {const selected=rankingModel.selection(participantId);const fallback=selected?Object.assign({},selected.entry,selected.context):{participantId};const detail=rankingModel.normalizeDetail(selected?.context?.detail||{},fallback);this.rankingDetailSource=detail;this.setData({rankingDetail:detail,rankingQuizRows:rankingModel.visibleQuizzes(detail.quizzes),rankingQuizQuery:'',rankingQuizSort:'takenAt',rankingQuizSortLabel:rankingModel.sortOptions[0].label})},
    setupQuiz() {
      const book=this.data.book
      let selectedPackage=quizPackage
      /* @demo-start */
      const formal=book.workId==='peter-rabbit'
      const legacyQuestions=(legacyQuizzes[book.chapterId]||[]).map((question,index)=>Object.assign({id:cueKey(book)+'-q'+(index+1)},question))
      if(!formal)selectedPackage={schemaVersion:1,workId:book.workId||book.id,pieceId:cueKey(book),contentVersion:book.contentVersion??null,quizVersion:1,mode:'fixed_order',masteryFeedbackPercent:80,questions:legacyQuestions}
      /* @demo-end */
      this.quizPackage=selectedPackage
      this.questions=this.quizPackage.questions||[]
      this.quizStartedAt=new Date().toISOString()
      this.selectedOptions=[]
      const question=this.questions[0]||null
      this.setData({question,questionIndex:0,answer:-1,checked:false,result:false,score:0,scores:[],quizResultStatus:'',quizTotal:this.questions.length,quizProgress:this.questions.length?100/this.questions.length:0,quizLabel:(book.chapterTitle||book.title)+' · 阅读小测',quizOptions:question?this.quizOptions(question):[]})
    },
    quizOptions(question) {return question.options.map((text,index)=>({text,index,letter:['A','B','C','D'][index],audio:(question.audio||[])[index]||''}))},
    updateSubtitles(seconds, force) {
      const key=cueKey(this.data.book)
      const cues=cuesByBook[key]||[]
      if(this.subtitleKey!==key){this.subtitleKey=key;this.subtitleLayout=subtitles.prepare(cues)}
      const view=subtitles.display(this.subtitleLayout,cues,Math.round(seconds*1000))
      if(force||view.start!==this.data.subtitleStart||view.current!==this.data.subtitleCurrent){this.setData({subtitleRows:view.rows,subtitleStart:view.start,subtitleCurrent:view.current,activeCue:view.current>=0?cues[view.current]:null})}
    },
    syncPlayer(session, force) {
      if(route!=='player'||session.pieceId!==cueKey(this.data.book))return
      const duration=Number(session.duration)||Number(this.data.book.duration)||0
      const update={playing:session.status==='playing'||session.status==='loading',playbackStatus:session.status,position:session.position||0,formatted:time(session.position||0),duration:time(duration),rate:session.rate||1,loop:!!session.loop}
      if(session.book)update.book=Object.assign({},this.data.book,session.book,{duration})
      this.setData(update)
      this.updateSubtitles(session.position||0,!!force)
      if(session.status==='error'&&this.lastPlayerError!==session.error){this.lastPlayerError=session.error;host.toast('音频加载失败，请稍后重试')}
    },
    attachPlayer() {if(route==='player'&&!this.playerUnsubscribe)this.playerUnsubscribe=player.subscribe(session=>this.syncPlayer(session,false))},
    detachPlayer() {if(this.playerUnsubscribe){this.playerUnsubscribe();this.playerUnsubscribe=null}this.wordResume=null},
    onShow() {this.refresh();if(route==='player'){this.attachPlayer();this.syncPlayer(player.snapshot(),true)}if(this.remoteLoadedOnce)this.loadRemote()},
    onHide() {this.detachPlayer()},
    refresh() {
      this.state = Object.assign(defaults(),host.read())
      /* @demo-start */
      if(isDemo)addDemoDefaults(this.state)
      /* @demo-end */
      const s=this.state
      if(!s.listeningSec&&Number(s.listeningSeconds)>0){s.listeningSec=Number(s.listeningSeconds);host.write(s)}
      this.stateBaseline=JSON.parse(JSON.stringify(s))
      const recent=s.recent.map(id=>visibleBooks.find(b=>b.id===id)).filter(Boolean)
      const pieces=Object.values(s.progress).filter(p=>p.completed).length
      const favoriteBooks=visibleBooks.filter(b=>s.favorites.includes(b.id))
      const readingList=this.data.recentMode==='favorites'?favoriteBooks:recent
      const compatiblePieces={}
      for(const book of visibleBooks){
        if(book.workId==='peter-rabbit')compatiblePieces[book.pieceId||book.id]={contentVersion:quizPackage.contentVersion,quizVersion:quizPackage.quizVersion}
        for(const chapter of book.chapters||[])compatiblePieces[chapter.id]={contentVersion:book.contentVersion??null,quizVersion:1}
      }
      const report=reportAggregate.summarize(s.results,compatiblePieces)
      const accountUser=isDemo?null:api.currentUser()
      const update={user:accountUser,favorites:s.favorites,favoriteBooks,readingList,savedWordsText:(s.words||[]).length?(s.words||[]).join(' · '):'在听读字幕中点击单词，把新认识的词收进来。',recent,results:report.history,reportTrend:report.trend,currentFavorite:s.favorites.includes(this.data.book.id),stats:{pieces,words:visibleBooks.filter(b=>s.progress[cueKey(b)]?.completed).reduce((a,b)=>a+b.words,0),correct:report.average,correctLabel:report.latest.length?report.average+'%':'—',listening:fmtListening(s.listeningSec)}}
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
    inputSearch(e) {this.setData({query:e.detail.value});this.filterBooks()},
    search() {host.go('library')},
    chooseFilter(e) {this.setData({filter:e.currentTarget.dataset.id});this.filterBooks()},
    filterBooks() {const q=this.data.query.trim().toLowerCase(); const f=this.data.filter; this.setData({shown:visibleBooks.filter(b=>(f==='all'||(f==='available'?b.stock>0:b.category===f))&&[b.title,b.author,b.zh,b.editionLabel,b.series,b.internalContentNumber,b.number].some(v=>String(v).toLowerCase().includes(q)))})},
    requireUser() {
      /* @demo-start */
      if(isDemo&&!this.state.user){host.go('login');return false}
      /* @demo-end */
      if(!isDemo&&!api.isAuthenticated()){host.go('login');return false}
      return true
    },
    /* @demo-start */
    requireDemo() {if(isDemo)return true;host.toast('该功能仅在开发演示模式开放');return false},
    /* @demo-end */
    toggleFavorite() {if(!this.requireUser())return;const id=this.data.book.id;this.state.favorites=this.state.favorites.includes(id)?this.state.favorites.filter(x=>x!==id):[...this.state.favorites,id];this.save();host.toast(this.data.currentFavorite?'已加入收藏':'已取消收藏')},
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
    closeSheet() {const token=this.data.sheet==='word'&&this.wordResume;this.wordResume=null;this.setData({sheet:''});const current=player.snapshot();if(token&&token.sessionId===current.sessionId&&token.pieceId===current.pieceId&&current.status==='paused'&&current.pauseReason==='word')player.resume()},
    noop() {},
    /* @demo-start */
    loginMethod(e) {this.setData({loginMethod:e.currentTarget.dataset.id})},
    phoneInput(e) {this.setData({phone:e.detail.value})},
    codeInput(e) {this.setData({code:e.detail.value})},
    sendCode() {if(!this.requireDemo())return;if(!/^1\d{10}$/.test(this.data.phone)){host.toast('请输入 11 位手机号');return}this.setData({codeSent:true});host.toast('演示验证码：123456，未发送短信')},
    /* @demo-end */
    agreement() {this.setData({agreed:!this.data.agreed})},
    async login() {
      /* @demo-start */
      if(isDemo){try{this.state.user=demoLogin(this.data.loginMethod,this.data.phone,this.data.code,this.data.agreed);this.save();host.toast('已进入演示账户');host.back()}catch(e){host.toast(e.message)}return}
      /* @demo-end */
      if(!this.data.agreed){host.toast('请先阅读并同意用户协议和隐私政策');return}
      if(!api.available()){host.toast('账户服务暂不可用，请检查开发环境 API 地址');return}
      this.setData({accountBusy:true})
      try{await api.loginWechat();this.refresh();host.toast('微信登录成功');host.back()}catch(error){host.toast(error?.code==='RATE_LIMITED'?'操作过于频繁，请稍后再试':'微信登录失败，请稍后重试')}finally{this.setData({accountBusy:false})}
    },
    async logout() {
      /* @demo-start */
      if(isDemo){this.state.user=null;this.save();this.setData({sheet:''});host.toast('已退出演示账户');return}
      /* @demo-end */
      try{await api.logout()}catch(_){}this.refresh();this.setData({sheet:''});host.toast('已退出账户')
    },
    startPlayer() {this.state.recent=[this.data.book.id,...this.state.recent.filter(id=>id!==this.data.book.id)].slice(0,30);this.save();player.selectTrack(playableBook(this.data.book));host.go('player',this.data.book.id)},
    startChapter(e) {const book=playableBook(this.data.book,e.currentTarget.dataset.id);this.state.recent=[this.data.book.id,...this.state.recent.filter(id=>id!==this.data.book.id)].slice(0,30);this.save();player.selectTrack(book);host.go('player',this.data.book.id+':'+e.currentTarget.dataset.id)},
    togglePlay() {
      if(this.data.playing){player.pause('user');return}
      const ok=player.playTrack(this.data.book)
      if(!ok)this.setData({sheet:'audio'})
    },
    seek(e) {const seconds=Number(e.detail.value);this.setData({position:seconds,formatted:time(seconds)});this.updateSubtitles(seconds,true);player.seek(seconds)},
    stepSentence(e) {const cues=cuesByBook[cueKey(this.data.book)]||[];if(!cues.length)return;const delta=Number(e.currentTarget.dataset.step);const current=this.data.subtitleCurrent;const target=Math.max(0,Math.min(cues.length-1,Math.max(0,current)+delta));const seconds=cues[target].startMs/1000;this.setData({position:seconds,formatted:time(seconds)});this.updateSubtitles(seconds,true);player.seek(seconds)},
    speed() {const rates=[0.75,1,1.25,1.5,2];const rate=rates[(rates.indexOf(this.data.rate)+1)%rates.length];player.setRate(rate)},
    loop() {const loop=!this.data.loop;player.setLoop(loop);host.toast(loop?'单篇循环':'顺序播放')},
    toggleSubtitle() {this.setData({subtitle:!this.data.subtitle})},
    word(e) {const surface=e.currentTarget.dataset.word;const key=e.currentTarget.dataset.vocabKey||surface.toLowerCase();let entry=peterVocab[key],garden=false;/* @demo-start */const formal=this.data.book.workId==='peter-rabbit';if(!formal){entry=legacyVocab[key];garden=surface.toLowerCase()==='garden'}/* @demo-end */const cues=cuesByBook[cueKey(this.data.book)]||[];const cue=cues[Number(e.currentTarget.dataset.cueIndex)]||this.data.activeCue;const current=player.snapshot();this.wordResume=current.status==='playing'&&current.pieceId===cueKey(this.data.book)?{sessionId:current.sessionId,pieceId:current.pieceId}:null;if(this.wordResume)player.pause('word');this.setData({sheet:'word',selectedWord:{surface,lemma:entry?.lemma||surface.toLowerCase(),phonetic:entry?.phonetic||entry?.ph|| (garden?'/ˈɡɑːdn/':'—'),partOfSpeech:entry?.partOfSpeech||entry?.pos|| (garden?'noun':'待审核'),definitionZh:entry?.definitionZh||entry?.zh|| (garden?'花园；园子':'释义待审核'),definitionEn:entry?.definitionEn||entry?.en|| (garden?'A place where flowers, fruit, or vegetables grow.':'This word is waiting for editorial review.'),example:cue?cue.text:'',translation:cue?.translation||''}})},
    saveWord() {if(!this.requireUser())return;const word=this.data.selectedWord.surface;this.state.words=[...new Set([...(this.state.words||[]),word])];this.save();host.toast(word+' 已加入生词本');this.closeSheet()},
    nextTrack(e) {const step=Number(e.currentTarget.dataset.step);const current=this.data.book;const base=visibleBooks.find(b=>b.id===current.id)||firstBook;const chapters=base.chapters||[];const index=chapters.findIndex(ch=>ch.id===current.chapterId);let book;if(chapters.length&&index+step>=0&&index+step<chapters.length)book=playableBook(base,chapters[index+step].id);else{const i=visibleBooks.findIndex(b=>b.id===current.id);book=playableBook(visibleBooks[(i+step+visibleBooks.length)%visibleBooks.length])}player.selectTrack(book);this.setData({book,duration:time(book.duration),position:0,formatted:'00:00',playing:false});this.updateSubtitles(0,true)},
    openQuiz() {const book=this.data.book;const pieceId=book.chapterId||(book.chapters||[])[0]?.id;/* @demo-start */if(book.workId!=='peter-rabbit'&&!(legacyQuizzes[pieceId]||[]).length){host.toast('这一章暂时没有小测');return}/* @demo-end */this.wordResume=null;player.pause('quiz');host.go('quiz',book.id+(pieceId?':'+pieceId:''))},
    playOption(e) {const option=this.data.quizOptions[Number(e.currentTarget.dataset.index)];if(!option?.audio)return;player.pause('quiz_option');if(!this.optionAudio)this.optionAudio=wx.createInnerAudioContext();this.optionAudio.stop();this.optionAudio.src=option.audio;this.optionAudio.play()},
    onUnload() {this.detachPlayer();if(this.optionAudio)this.optionAudio.destroy()},
    answer(e) {if(!this.data.checked)this.setData({answer:Number(e.currentTarget.dataset.index)})},
    nextQuestion() {if(this.data.answer<0){host.toast('先选择一个答案吧');return}if(!this.data.checked){this.setData({checked:true});return}const scores=[...this.data.scores,this.data.answer===this.data.question.answer?1:0];this.selectedOptions[this.data.questionIndex]=this.data.answer;const n=this.data.questionIndex+1;if(n>=this.questions.length){const attempt=quizAttempts.createLocalAttempt({quizPackage:this.quizPackage,book:this.data.book,selectedOptions:this.selectedOptions,startedAt:this.quizStartedAt});this.state.results=[attempt,...this.state.results];this.save();this.setData({result:true,score:attempt.score,scores,quizResultStatus:'本机练习结果 · 未经服务端验证'});this.submitQuizAttempt(attempt)}else{const question=this.questions[n];this.setData({questionIndex:n,question,quizOptions:this.quizOptions(question),quizProgress:(n+1)/this.questions.length*100,answer:-1,checked:false,scores})}},
    async submitQuizAttempt(attempt) {if(!api.available()||!api.isAuthenticated())return;try{const result=await api.submitQuiz(attempt);const merged=Object.assign({},attempt,result,{title:attempt.title});this.state.results=this.state.results.map(item=>item.attemptId===attempt.attemptId?merged:item);this.save();this.setData({score:result.score??attempt.score,quizResultStatus:result.status==='server_verified'?'服务端已验证 · 已计入可信统计':'服务端已拒绝 · '+(result.error?.message||'请重新作答')})}catch(error){this.setData({quizResultStatus:error?.code==='RATE_LIMITED'?'提交过于频繁，结果暂存本机':'网络提交失败 · 结果已安全保存在本机'})}},
    retryQuiz() {this.setupQuiz()},
    async loadRemote() {
      this.remoteLoadedOnce=true
      if(!api.available())return
      if(route==='ranking'){await this.loadRankingOptions();await this.loadRanking();return}
      if(route==='ranking-detail'){await this.loadRankingDetail(this.remoteParticipantId);return}
      if(['home','library'].includes(route)){await this.loadRemoteCatalog();return}
      if(['detail','player','quiz'].includes(route))await this.loadRemoteContent()
    },
    async loadRemoteCatalog() {
      if(!api.isAuthenticated())return
      try{
        const response=await api.listWorks(null,50)
        if(!response.items?.length){this.setData({remoteCatalogStatus:'empty'});return}
        const merged=response.items.map(item=>{const local=visibleBooks.find(book=>book.id===item.workId);return Object.assign({},local||{id:item.workId,author:'',zh:'',series:'',editionLabel:'',number:item.workId,internalContentNumber:item.workId,words:0,pages:null,category:'fiction',stock:0,chapters:[]},{id:item.workId,workId:item.workId,title:item.title,cover:item.coverUrl||(local&&local.cover),pieceCount:item.pieceCount,access:item.access})})
        this.setData({books:merged,shown:merged,featured:merged.slice(0,3),recommendations:merged.slice(0,2),remoteCatalogStatus:'ready'})
      }catch(_){this.setData({remoteCatalogStatus:'unavailable'})}
    },
    async loadRemoteContent() {
      if(!api.isAuthenticated())return
      try{
        const response=await api.getWork(this.data.book.workId||this.data.book.id)
        const wanted=cueKey(this.data.book),piece=response.pieces.find(item=>item.pieceId===wanted)||response.pieces[0]
        if(!piece)return
        const manifest=await api.getManifest(piece.pieceId,piece.currentContentVersion)
        const audio=manifest.assets.find(asset=>asset.type==='audio'),cover=manifest.assets.find(asset=>asset.type==='cover')
        const book=Object.assign({},this.data.book,{workId:manifest.workId,pieceId:manifest.pieceId,contentVersion:manifest.contentVersion,quizVersion:manifest.quizVersion,localAudio:audio?.url||this.data.book.localAudio,cover:cover?.url||this.data.book.cover,remoteManifest:manifest})
        this.setData({book,duration:time(book.duration)})
      }catch(_){}
    },
    rankingFilters() {
      const periodType=this.data.rankingType==='seven'?'rolling7':this.data.rankingType
      const periodKey=periodType==='week'?this.data.selectedWeek:periodType==='month'?this.data.selectedMonth:undefined
      return {campusId:this.data.campus,periodType,periodKey,grade:this.data.rankGrade,level:this.data.rankLevel,limit:50}
    },
    async loadRankingOptions() {
      if(!api.isAuthenticated())return
      try{
        const options=await api.rankingOptions()
        const campusOptionsRemote=options.campuses.map(item=>({id:item.value,label:item.label}))
        const rankingTypesRemote=options.periodTypes.map(item=>({id:item.value==='rolling7'?'seven':item.value,label:item.label,description:item.requiresPeriodSelection?'选择具体周期':'当前周期'}))
        const weekOptionsRemote=options.periods.week.map(item=>({id:item.key,label:item.label,description:shortDate(new Date(item.startsAt))+'–'+shortDate(new Date(item.endsAt))}))
        const monthOptionsRemote=options.periods.month.map(item=>({id:item.key,label:item.label,description:item.key}))
        this.setData({campusOptions:campusOptionsRemote.length?campusOptionsRemote:this.data.campusOptions,rankingTypes:rankingTypesRemote.length?rankingTypesRemote:this.data.rankingTypes,weekOptions:weekOptionsRemote.length?weekOptionsRemote:this.data.weekOptions,monthOptions:monthOptionsRemote.length?monthOptionsRemote:this.data.monthOptions,gradeOptions:options.grades.map(item=>({id:item.value,label:item.label})),levelOptions:options.levels.map(item=>({id:item.value,label:item.label}))})
      }catch(_){}
    },
    async loadRanking() {
      if(!api.isAuthenticated()){const state=rankingState.view('unauthenticated');this.setData({rankingStatus:state.status,rankingStatusTitle:state.title,rankingStatusDescription:state.description,rankingEntries:[]});return}
      if(!api.available()){const state=rankingState.view('unavailable');this.setData({rankingStatus:state.status,rankingStatusTitle:state.title,rankingStatusDescription:state.description,rankingEntries:[]});return}
      const token=Date.now()+Math.random();this.rankingRequestToken=token
      try{const payload=await api.rankings(this.rankingFilters());if(this.rankingRequestToken!==token)return;const currentId=payload.currentUser?.participantId;payload.items=(payload.items||[]).map(item=>Object.assign({},item,{isCurrentUser:item.participantId===currentId}));this.applyRankingPayload(payload)}catch(error){if(this.rankingRequestToken!==token)return;const state=rankingState.view(error?.code==='UNAUTHENTICATED'?'unauthenticated':'unavailable');this.setData({rankingStatus:state.status,rankingStatusTitle:state.title,rankingStatusDescription:state.description,rankingEntries:[]})}
    },
    async loadRankingDetail(participantId) {
      if(!participantId||!api.available()||!api.isAuthenticated())return
      try{const payload=await api.rankingDetail(participantId,Object.assign(this.rankingFilters(),{limit:100}));this.applyRankingDetail(payload)}catch(_){}
    },
    chooseRecentMode(e) {const recentMode=e.currentTarget.dataset.id;this.setData({recentMode,readingList:recentMode==='favorites'?this.data.favoriteBooks:this.data.recent})},
    chooseCampus(e) {const option=this.data.campusOptions.find(item=>item.id===e.currentTarget.dataset.id);if(option){this.setData({campus:option.id,campusLabel:option.label,sheet:''});this.loadRanking()}},
    chooseRankingType(e) {const option=this.data.rankingTypes.find(item=>item.id===e.currentTarget.dataset.id);if(option){this.setData({rankingType:option.id,rankingTypeLabel:option.label,sheet:''});this.loadRanking()}},
    chooseRankingPeriod(e) {const options=this.data.rankingType==='week'?this.data.weekOptions:this.data.monthOptions;const option=options.find(item=>item.id===e.currentTarget.dataset.id);if(!option)return;if(this.data.rankingType==='week')this.setData({selectedWeek:option.id,selectedWeekLabel:option.label,sheet:''});else this.setData({selectedMonth:option.id,selectedMonthLabel:option.label,sheet:''});this.loadRanking()},
    chooseRankGrade(e) {const option=this.data.gradeOptions.find(item=>item.id===e.currentTarget.dataset.id);if(option)this.setData({rankGrade:option.id,rankGradeLabel:option.label})},
    chooseRankLevel(e) {const option=this.data.levelOptions.find(item=>item.id===e.currentTarget.dataset.id);if(option)this.setData({rankLevel:option.id,rankLevelLabel:option.label})},
    applyRankFilter() {this.setData({sheet:''});this.loadRanking()},
    applyRankingPayload(payload) {const board=rankingModel.normalizeLeaderboard(payload);const state=rankingState.view(board.status);this.rankingDetailsByParticipant=payload?.detailsByParticipant||{};this.setData({rankingStatus:state.status,rankingStatusTitle:state.title,rankingStatusDescription:state.description,rankingEntries:board.items,rankingRangeLabel:board.rangeLabel,rankingStartsAt:board.startsAt,rankingEndsAt:board.endsAt,rankingRuleVersion:board.ruleVersion})},
    openRankingDetail(e) {const participantId=e.currentTarget.dataset.id;const entry=this.data.rankingEntries.find(item=>item.participantId===participantId);if(!entry){host.toast('该排名明细暂不可用');return}rankingModel.rememberSelection(entry,{periodLabel:this.data.rankingTypeLabel,startsAt:this.data.rankingStartsAt,endsAt:this.data.rankingEndsAt,rangeLabel:this.data.rankingRangeLabel,ruleVersion:this.data.rankingRuleVersion,detail:this.rankingDetailsByParticipant?.[participantId]});host.go('ranking-detail',participantId)},
    applyRankingDetail(payload) {const fallback=this.data.rankingDetail||{};const detail=rankingModel.normalizeDetail(payload,fallback);this.rankingDetailSource=detail;this.setData({rankingDetail:detail,rankingQuizRows:rankingModel.visibleQuizzes(detail.quizzes,this.data.rankingQuizQuery,this.data.rankingQuizSort)})},
    inputRankingQuizSearch(e) {const query=e.detail.value;this.setData({rankingQuizQuery:query,rankingQuizRows:rankingModel.visibleQuizzes(this.rankingDetailSource?.quizzes||[],query,this.data.rankingQuizSort)})},
    chooseRankingQuizSort(e) {const option=rankingModel.sortOptions.find(item=>item.id===e.currentTarget.dataset.id);if(!option)return;this.setData({rankingQuizSort:option.id,rankingQuizSortLabel:option.label,rankingQuizRows:rankingModel.visibleQuizzes(this.rankingDetailSource?.quizzes||[],this.data.rankingQuizQuery,option.id),sheet:''})},
    noopRanking() {}
  }
}
module.exports = { createPage, getProductPolicy:productMode.current }
