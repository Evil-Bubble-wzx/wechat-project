const { books, questions } = require('../modules/catalog/books')
const { demoLogin } = require('../modules/account/session')
const rules = require('../modules/physical-loan/rules')
const host = require('../services/host')
const player = require('../modules/listen-read/player')
const cuesByBook = require('../modules/listen-read/cues-data')
const defaults = () => ({ favorites:[], loans:[], recent:[], progress:{}, results:[], listeningSeconds:0, user:null })
const tabs = [{id:'home',label:'Home',icon:'home'},{id:'recent',label:'Recent',icon:'play'},{id:'me',label:'Me',icon:'user'}]
const titles = { home:'Tingyue',library:'Find Books',loans:'Borrowed',me:'Me',detail:'Book Details',player:'Read for Me',recent:'Recent',report:'My Quizzes',ranking:'Rankings',login:'Welcome',quiz:'Take Quiz' }
const campusOptions = [{id:'a',label:'A Campus'},{id:'b',label:'B Campus'}]
const rankingTypes = [
  {id:'seven',label:'7-Day',description:'Rolling last 7 days'},
  {id:'week',label:'Weekly',description:'Strict calendar week'},
  {id:'month',label:'Monthly',description:'Calendar month'},
  {id:'year',label:'Yearly',description:'Calendar year'}
]
const weekOptions = [
  {id:'2026-W38',label:'2026 · Week 38'},
  {id:'2026-W37',label:'2026 · Week 37'},
  {id:'2026-W36',label:'2026 · Week 36'},
  {id:'2026-W35',label:'2026 · Week 35'}
]
const monthOptions = [
  {id:'2026-09',label:'September 2026'},
  {id:'2026-08',label:'August 2026'},
  {id:'2026-07',label:'July 2026'},
  {id:'2026-06',label:'June 2026'}
]
const gradeOptions = [{id:'all',label:'All Grades'},{id:'k',label:'Kindergarten'},...Array.from({length:9},(_,i)=>({id:String(i+1),label:'Grade '+(i+1)}))]
const levelOptions = [{id:'all',label:'All Levels'},...Array.from({length:5},(_,i)=>({id:String(i+1),label:'Lv '+(i+1)+'.x'}))]
const time = s => Math.floor(s/60).toString().padStart(2,'0') + ':' + Math.floor(s%60).toString().padStart(2,'0')
const listeningTime = seconds => {
  const total=Math.max(0,Math.floor(Number(seconds)||0))
  return [Math.floor(total/3600),Math.floor(total%3600/60),total%60].map(value=>String(value).padStart(2,'0')).join(':')
}
const findCue = (cues, milliseconds) => {
  let low=0,high=cues.length-1
  while(low<=high){const middle=Math.floor((low+high)/2),cue=cues[middle];if(milliseconds<cue.startMs)high=middle-1;else if(milliseconds>=cue.endMs)low=middle+1;else return cue}
  return null
}
function createPage(route) {
  return {
    data: { route, title:titles[route], tabs, isTab:tabs.some(t=>t.id===route), inset:24, books, featured:books.slice(0,3), recommendations:[books[4],books[3]], book:books[0], query:'',filter:'all', loanFilter:'all', loanTabs:[{id:'all',label:'All'},{id:'reserved',label:'Pending'},{id:'borrowed',label:'On Loan'},{id:'cancelled',label:'Cancelled'}], filters:[{id:'all',label:'All Books'},{id:'fiction',label:'Fiction'},{id:'nonfiction',label:'Nonfiction'},{id:'available',label:'Available'}], shown:books, loanList:[], totalLoans:0, favorites:[], favoriteBooks:[], recent:[], readingList:[], recentMode:'recent', user:null, sheet:'', agreed:false, loginMethod:'wechat', phone:'',code:'',codeSent:false, playing:false, rate:1, position:0, formatted:'00:00',duration:time(books[0].duration), listeningTime:'00:00:00', subtitle:false, activeCue:null, selectedWord:{surface:'',phonetic:'—',partOfSpeech:'pending',definitionZh:'释义待审核',definitionEn:'This word is waiting for editorial review.',example:''}, loop:false, question:questions[0], questionIndex:0, answer:-1, result:false, score:0, scores:[], quizTotal:questions.length, results:[], campusOptions, campus:'a', campusLabel:'A Campus', rankingTypes, rankingType:'seven', rankingTypeLabel:'7-Day', weekOptions, monthOptions, selectedWeek:'2026-W38', selectedWeekLabel:'2026 · Week 38', selectedMonth:'2026-09', selectedMonthLabel:'September 2026', gradeOptions, levelOptions, rankGrade:'all', rankGradeLabel:'All Grades', rankLevel:'all', rankLevelLabel:'All Levels', stats:{pieces:0,words:0,correct:0}, currentFavorite:false, isDemo:true },
    onLoad(options) {const book=options&&options.id?books.find(b=>b.id===options.id)||books[0]:books[0];this.setData({inset:host.inset(),book,duration:time(book.duration),activeCue:findCue(cuesByBook[book.id]||[],0)});this.refresh()},
    onShow() { this.refresh() },
    refresh() {
      this.state = Object.assign(defaults(),host.read())
      const s=this.state
      const loanList=s.loans.map(l=>Object.assign({},l,{book:books.find(b=>b.id===l.bookId)})).filter(l=>l.book && (this.data.loanFilter==='all'||l.status===this.data.loanFilter))
      const recent=s.recent.map(id=>books.find(b=>b.id===id)).filter(Boolean)
      const pieces=Object.values(s.progress).filter(p=>p.completed).length
      const favoriteBooks=books.filter(b=>s.favorites.includes(b.id))
      const readingList=this.data.recentMode==='favorites'?favoriteBooks:recent
      this.setData({user:s.user,favorites:s.favorites,favoriteBooks,readingList,listeningTime:listeningTime(s.listeningSeconds),savedWordsText:(s.words||[]).length?'garden  /ˈɡɑːdn/  n. 花园；园子':'在听读字幕中点击单词，把新认识的词收进来。',loanList,totalLoans:s.loans.filter(l=>l.status!=='cancelled').length,recent,results:s.results, currentFavorite:s.favorites.includes(this.data.book.id),stats:{pieces,words:books.filter(b=>s.progress[b.id]?.completed).reduce((a,b)=>a+b.words,0),correct:s.results.length?Math.round(s.results.reduce((a,r)=>a+r.score,0)/s.results.length):0}})
    },
    save() { host.write(this.state); this.refresh() },
    nav(e) {host.go(e.currentTarget.dataset.page,e.currentTarget.dataset.id)},
    back() {host.back()},
    openBook(e) {host.go('detail',e.currentTarget.dataset.id)},
    inputSearch(e) {this.setData({query:e.detail.value});this.filterBooks()},
    search() {host.go('library')},
    chooseFilter(e) {this.setData({filter:e.currentTarget.dataset.id});this.filterBooks()},
    filterBooks() {const q=this.data.query.trim().toLowerCase(); const f=this.data.filter; this.setData({shown:books.filter(b=>(f==='all'||(f==='available'?b.stock>0:b.category===f))&&[b.title,b.author,b.zh,b.series,b.number].some(v=>String(v).toLowerCase().includes(q)))})},
    requireUser() {if(!this.state.user){host.go('login');return false}return true},
    toggleFavorite() {if(!this.requireUser())return;const id=this.data.book.id;this.state.favorites=this.state.favorites.includes(id)?this.state.favorites.filter(x=>x!==id):[...this.state.favorites,id];this.save();host.toast(this.data.currentFavorite?'已加入收藏':'已取消收藏')},
    openReserve() {if(!this.requireUser())return;if(!this.data.book.stock){host.toast('暂无可借库存，可以先听读');return}this.setData({sheet:'reserve'})},
    confirmReserve() {try{this.state.loans=rules.reserve(this.state.loans,this.data.book);this.save();this.setData({sheet:''});host.go('loans')}catch(e){host.toast(e.message)}},
    loanFilter(e) {this.setData({loanFilter:e.currentTarget.dataset.id});this.refresh()},
    cancelLoan(e) {this.state.loans=this.state.loans.map(l=>l.id===e.currentTarget.dataset.id&&l.status==='reserved'?Object.assign({},l,{status:'cancelled',label:'已取消',due:'库存将在正式服务中释放'}):l);this.save();host.toast('演示预约已取消')},
    renewLoan(e) {try{this.state.loans=this.state.loans.map(l=>l.id===e.currentTarget.dataset.id?rules.renew(l):l);this.save();host.toast('续借成功')}catch(e){host.toast(e.message)}},
    showSheet(e) {this.setData({sheet:e.currentTarget.dataset.sheet})},
    closeSheet() {this.setData({sheet:''})},
    noop() {},
    agreement() {this.setData({agreed:!this.data.agreed})},
    loginMethod(e) {this.setData({loginMethod:e.currentTarget.dataset.id})},
    phoneInput(e) {this.setData({phone:e.detail.value})},
    codeInput(e) {this.setData({code:e.detail.value})},
    sendCode() {if(!/^1\d{10}$/.test(this.data.phone)){host.toast('请输入 11 位手机号');return}this.setData({codeSent:true});host.toast('演示验证码：123456，未发送短信')},
    login() {try{this.state.user=demoLogin(this.data.loginMethod,this.data.phone,this.data.code,this.data.agreed);this.save();host.toast('已进入演示账户');host.back()}catch(e){host.toast(e.message)}},
    logout() {this.state.user=null;this.save();this.setData({sheet:''});host.toast('已退出演示账户')},
    startPlayer() {this.state.recent=[this.data.book.id,...this.state.recent.filter(id=>id!==this.data.book.id)].slice(0,30);this.save();host.go('player',this.data.book.id)},
    togglePlay() {
      if(this.data.playing){player.pause();this._lastListeningPosition=null;this.setData({playing:false});return}
      const id=this.data.book.id
      this._lastListeningPosition=this.data.position
      const ok=player.play(this.data.book,(seconds,actualDuration)=>{
        const update={position:seconds,formatted:time(seconds)}
        const delta=seconds-this._lastListeningPosition
        const elapsed=delta/(Number(this.data.rate)||1)
        if(this.data.playing&&delta>0&&elapsed<=5){this.state.listeningSeconds=(Number(this.state.listeningSeconds)||0)+elapsed;update.listeningTime=listeningTime(this.state.listeningSeconds)}
        this._lastListeningPosition=seconds
        const cue=findCue(cuesByBook[id]||[],Math.round(seconds*1000));if((cue&&cue.id)!==(this.data.activeCue&&this.data.activeCue.id))update.activeCue=cue
        if(Number.isFinite(actualDuration)&&actualDuration>0) {update.book=Object.assign({},this.data.book,{duration:actualDuration});update.duration=time(actualDuration)}
        this.setData(update)
        this.state.progress[id]={seconds,completed:!!this.state.progress[id]?.completed};host.write(this.state)
      },()=>{
        this.state.progress[id]={seconds:this.data.book.duration,completed:true};host.write(this.state)
        if(this.data.loop){this._lastListeningPosition=0;player.seek(0);player.resume()}else{this._lastListeningPosition=null;this.setData({playing:false})}
      },()=>{this._lastListeningPosition=null;this.setData({playing:false});host.toast('音频加载失败，请稍后重试')})
      if(ok){player.rate(this.data.rate);this.setData({playing:true})}else this.setData({sheet:'audio'})
    },
    seek(e) {const seconds=Number(e.detail.value);this._lastListeningPosition=seconds;this.setData({position:seconds,formatted:time(seconds),activeCue:findCue(cuesByBook[this.data.book.id]||[],Math.round(seconds*1000))});player.seek(seconds)},
    speed() {const rates=[0.75,1,1.25,1.5,2];const rate=rates[(rates.indexOf(this.data.rate)+1)%rates.length];this.setData({rate});player.rate(rate)},
    loop() {this.setData({loop:!this.data.loop});host.toast(this.data.loop?'单篇循环':'顺序播放')},
    toggleSubtitle() {this.setData({subtitle:!this.data.subtitle})},
    word(e) {const surface=e.currentTarget.dataset.word;const garden=surface.toLowerCase()==='garden';player.pause();this._lastListeningPosition=null;this.setData({playing:false,sheet:'word',selectedWord:{surface,phonetic:garden?'/ˈɡɑːdn/':'—',partOfSpeech:garden?'noun':'pending',definitionZh:garden?'花园；园子':'释义待审核',definitionEn:garden?'A place where flowers, fruit, or vegetables grow.':'This word is waiting for editorial review.',example:this.data.activeCue?this.data.activeCue.text:''}})},
    saveWord() {if(!this.requireUser())return;const word=this.data.selectedWord.surface;this.state.words=[...new Set([...(this.state.words||[]),word])];this.save();host.toast(word+' 已加入生词本');this.setData({sheet:''})},
    nextTrack(e) {const i=books.findIndex(b=>b.id===this.data.book.id);const book=books[(i+Number(e.currentTarget.dataset.step)+books.length)%books.length];player.pause();this._lastListeningPosition=null;this.setData({book,duration:time(book.duration),position:0,formatted:'00:00',playing:false,activeCue:findCue(cuesByBook[book.id]||[],0)})},
    openQuiz() {if(!this.requireUser())return;if(this.data.book.id!=='peter'){host.toast('当前仅彼得兔提供演示题目');return}host.go('quiz',this.data.book.id)},
    answer(e) {this.setData({answer:Number(e.currentTarget.dataset.index)})},
    nextQuestion() {if(this.data.answer<0){host.toast('先选择一个答案吧');return}const scores=[...this.data.scores,this.data.answer===this.data.question.answer?1:0];const n=this.data.questionIndex+1;if(n>=questions.length){const score=Math.round(scores.reduce((a,b)=>a+b,0)/questions.length*100);this.state.results=[{id:Date.now(),title:this.data.book.title,score,date:new Date().toLocaleDateString()},...this.state.results];this.save();this.setData({result:true,score,scores})}else this.setData({questionIndex:n,question:questions[n],answer:-1,scores})},
    retryQuiz() {this.setData({questionIndex:0,question:questions[0],answer:-1,result:false,scores:[]})},
    chooseRecentMode(e) {const recentMode=e.currentTarget.dataset.id;this.setData({recentMode,readingList:recentMode==='favorites'?this.data.favoriteBooks:this.data.recent})},
    chooseCampus(e) {const option=campusOptions.find(item=>item.id===e.currentTarget.dataset.id);if(option)this.setData({campus:option.id,campusLabel:option.label,sheet:''})},
    chooseRankingType(e) {const option=rankingTypes.find(item=>item.id===e.currentTarget.dataset.id);if(option)this.setData({rankingType:option.id,rankingTypeLabel:option.label,sheet:''})},
    chooseRankingPeriod(e) {
      const options=this.data.rankingType==='week'?weekOptions:monthOptions
      const option=options.find(item=>item.id===e.currentTarget.dataset.id)
      if(!option)return
      if(this.data.rankingType==='week')this.setData({selectedWeek:option.id,selectedWeekLabel:option.label,sheet:''})
      else this.setData({selectedMonth:option.id,selectedMonthLabel:option.label,sheet:''})
    },
    chooseRankGrade(e) {const option=gradeOptions.find(item=>item.id===e.currentTarget.dataset.id);if(option)this.setData({rankGrade:option.id,rankGradeLabel:option.label})},
    chooseRankLevel(e) {const option=levelOptions.find(item=>item.id===e.currentTarget.dataset.id);if(option)this.setData({rankLevel:option.id,rankLevelLabel:option.label})},
    applyRankFilter() {this.setData({sheet:''})}
  }
}
module.exports = { createPage }
