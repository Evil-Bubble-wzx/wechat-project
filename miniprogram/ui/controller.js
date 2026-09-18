const { books, questions } = require('../modules/catalog/books')
const { demoLogin } = require('../modules/account/session')
const rules = require('../modules/physical-loan/rules')
const host = require('../services/host')
const player = require('../modules/listen-read/player')
const cuesByBook = Object.assign({}, require('../modules/listen-read/cues-data'), require('../modules/listen-read/legacy-cues-data'))
const legacyVocab = require('../modules/listen-read/legacy-vocab-data')
const legacyQuizzes = require('../modules/listen-read/legacy-quiz-data')
const subtitles = require('../modules/listen-read/subtitles')
const defaults = () => ({ favorites:[], loans:[], recent:[], progress:{}, results:[], user:null })
const tabs = [{id:'home',label:'Home',icon:'home'},{id:'recent',label:'Recent',icon:'play'},{id:'me',label:'Me',icon:'user'}]
const titles = { home:'Tingyue',library:'Find Books',loans:'Borrowed',me:'Me',detail:'Book Details',player:'Read for Me',recent:'Recent',report:'My Quizzes',ranking:'Rankings',login:'Welcome',quiz:'Take Quiz' }
const time = s => Math.floor(s/60).toString().padStart(2,'0') + ':' + Math.floor(s%60).toString().padStart(2,'0')
function playableBook(book, chapterId) {
  const chapter = (book.chapters || []).find(item => item.id === chapterId) || (book.chapters || [])[0]
  return chapter ? Object.assign({}, book, { chapterId: chapter.id, chapterTitle: chapter.title, duration: chapter.duration, localAudio: chapter.localAudio, hasQuiz: chapter.hasQuiz }) : book
}
function cueKey(book) { return book.chapterId || book.id }
const findCue = (cues, milliseconds) => {
  let low=0,high=cues.length-1
  while(low<=high){const middle=Math.floor((low+high)/2),cue=cues[middle];if(milliseconds<cue.startMs)high=middle-1;else if(milliseconds>=cue.endMs)low=middle+1;else return cue}
  return high >= 0 ? cues[high] : null
}
function createPage(route) {
  return {
    data: { route, title:titles[route], tabs, isTab:tabs.some(t=>t.id===route), inset:24, books, featured:books.slice(0,3), recommendations:[books[4],books[3]], book:books[0], query:'',filter:'all', loanFilter:'all', loanTabs:[{id:'all',label:'All'},{id:'reserved',label:'Pending'},{id:'borrowed',label:'On Loan'},{id:'cancelled',label:'Cancelled'}], filters:[{id:'all',label:'All Books'},{id:'fiction',label:'Fiction'},{id:'nonfiction',label:'Nonfiction'},{id:'available',label:'Available'}], shown:books, loanList:[], totalLoans:0, favorites:[], recent:[], user:null, sheet:'', agreed:false, loginMethod:'wechat', phone:'',code:'',codeSent:false, playing:false, rate:1, position:0, formatted:'00:00',duration:time(books[0].duration), subtitle:true, subtitleRows:[], subtitleStart:null, subtitleCurrent:-1, activeCue:null, selectedWord:{surface:'',phonetic:'—',partOfSpeech:'pending',definitionZh:'释义待审核',definitionEn:'This word is waiting for editorial review.',example:''}, loop:false, question:questions[0], questionIndex:0, answer:-1, checked:false, result:false, score:0, scores:[], quizTotal:questions.length, quizProgress:20, quizLabel:'THE TALE OF PETER RABBIT · 示例测验', quizOptions:[], results:[], period:'week', stats:{pieces:0,words:0,correct:0}, currentFavorite:false, isDemo:true },
    onLoad(options) {const [bookId,chapterId]=((options&&options.id)||books[0].id).split(':');const base=books.find(b=>b.id===bookId)||books[0];const book=route==='player'||route==='quiz'?playableBook(base,chapterId):base;this.setData({inset:host.inset(),book,duration:time(book.duration)});if(route==='player')this.updateSubtitles(0,true);if(route==='quiz')this.setupQuiz();this.refresh()},
    setupQuiz() {
      const book=this.data.book
      this.questions=book.id==='peter'?questions:(legacyQuizzes[book.chapterId]||[])
      const question=this.questions[0]||null
      this.setData({question,questionIndex:0,answer:-1,checked:false,result:false,score:0,scores:[],quizTotal:this.questions.length,quizProgress:this.questions.length?100/this.questions.length:0,quizLabel:(book.chapterTitle||book.title)+' · 阅读小测',quizOptions:question?this.quizOptions(question):[]})
    },
    quizOptions(question) {return question.options.map((text,index)=>({text,index,letter:['A','B','C','D'][index],audio:(question.audio||[])[index]||''}))},
    updateSubtitles(seconds, force) {
      const key=cueKey(this.data.book)
      const cues=cuesByBook[key]||[]
      if(this.subtitleKey!==key){this.subtitleKey=key;this.subtitleLayout=subtitles.prepare(cues)}
      const view=subtitles.display(this.subtitleLayout,cues,Math.round(seconds*1000))
      if(force||view.start!==this.data.subtitleStart||view.current!==this.data.subtitleCurrent){this.setData({subtitleRows:view.rows,subtitleStart:view.start,subtitleCurrent:view.current,activeCue:view.current>=0?cues[view.current]:null})}
    },
    onShow() { this.refresh() },
    refresh() {
      this.state = Object.assign(defaults(),host.read())
      const s=this.state
      const loanList=s.loans.map(l=>Object.assign({},l,{book:books.find(b=>b.id===l.bookId)})).filter(l=>l.book && (this.data.loanFilter==='all'||l.status===this.data.loanFilter))
      const recent=s.recent.map(id=>books.find(b=>b.id===id)).filter(Boolean)
      const pieces=Object.values(s.progress).filter(p=>p.completed).length
      this.setData({user:s.user,favorites:s.favorites,favoriteBooks:books.filter(b=>s.favorites.includes(b.id)),savedWordsText:(s.words||[]).length?'garden  /ˈɡɑːdn/  n. 花园；园子':'在听读字幕中点击单词，把新认识的词收进来。',loanList,totalLoans:s.loans.filter(l=>l.status!=='cancelled').length,recent,results:s.results, currentFavorite:s.favorites.includes(this.data.book.id),stats:{pieces,words:books.filter(b=>s.progress[b.id]?.completed).reduce((a,b)=>a+b.words,0),correct:s.results.length?Math.round(s.results.reduce((a,r)=>a+r.score,0)/s.results.length):0}})
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
    startChapter(e) {this.state.recent=[this.data.book.id,...this.state.recent.filter(id=>id!==this.data.book.id)].slice(0,30);this.save();host.go('player',this.data.book.id+':'+e.currentTarget.dataset.id)},
    togglePlay() {
      if(this.data.playing){player.pause();this.setData({playing:false});return}
      const id=this.data.book.id
      const pieceId=cueKey(this.data.book)
      const ok=player.play(this.data.book,(seconds,actualDuration)=>{
        const update={position:seconds,formatted:time(seconds)}
        this.updateSubtitles(seconds,false)
        if(Number.isFinite(actualDuration)&&actualDuration>0) {update.book=Object.assign({},this.data.book,{duration:actualDuration});update.duration=time(actualDuration)}
        this.setData(update)
        this.state.progress[pieceId]={seconds,completed:!!this.state.progress[pieceId]?.completed};host.write(this.state)
      },()=>{
        this.state.progress[pieceId]={seconds:this.data.book.duration,completed:true};host.write(this.state)
        if(this.data.loop){player.seek(0);player.resume()}else this.setData({playing:false})
      },()=>{this.setData({playing:false});host.toast('音频加载失败，请稍后重试')})
      if(ok){player.rate(this.data.rate);this.setData({playing:true})}else this.setData({sheet:'audio'})
    },
    seek(e) {const seconds=Number(e.detail.value);this.setData({position:seconds,formatted:time(seconds)});this.updateSubtitles(seconds,true);player.seek(seconds)},
    stepSentence(e) {const cues=cuesByBook[cueKey(this.data.book)]||[];if(!cues.length)return;const delta=Number(e.currentTarget.dataset.step);const current=this.data.subtitleCurrent;const target=Math.max(0,Math.min(cues.length-1,Math.max(0,current)+delta));const seconds=cues[target].startMs/1000;this.setData({position:seconds,formatted:time(seconds)});this.updateSubtitles(seconds,true);player.seek(seconds)},
    speed() {const rates=[0.75,1,1.25,1.5,2];const rate=rates[(rates.indexOf(this.data.rate)+1)%rates.length];this.setData({rate});player.rate(rate)},
    loop() {this.setData({loop:!this.data.loop});host.toast(this.data.loop?'单篇循环':'顺序播放')},
    toggleSubtitle() {this.setData({subtitle:!this.data.subtitle})},
    word(e) {const surface=e.currentTarget.dataset.word;const key=e.currentTarget.dataset.vocabKey||surface.toLowerCase();const entry=legacyVocab[key];const garden=surface.toLowerCase()==='garden';const cues=cuesByBook[cueKey(this.data.book)]||[];const cue=cues[Number(e.currentTarget.dataset.cueIndex)]||this.data.activeCue;player.pause();this.setData({playing:false,sheet:'word',selectedWord:{surface,phonetic:entry?.ph|| (garden?'/ˈɡɑːdn/':'—'),partOfSpeech:entry?.pos|| (garden?'noun':'待审核'),definitionZh:entry?.zh|| (garden?'花园；园子':'释义待审核'),definitionEn:entry?.en|| (garden?'A place where flowers, fruit, or vegetables grow.':'This word is waiting for editorial review.'),example:cue?cue.text:'',translation:cue?.translation||''}})},
    saveWord() {if(!this.requireUser())return;const word=this.data.selectedWord.surface;this.state.words=[...new Set([...(this.state.words||[]),word])];this.save();host.toast(word+' 已加入生词本');this.setData({sheet:''})},
    nextTrack(e) {const step=Number(e.currentTarget.dataset.step);const current=this.data.book;const base=books.find(b=>b.id===current.id);const chapters=base.chapters||[];const index=chapters.findIndex(ch=>ch.id===current.chapterId);let book;if(chapters.length&&index+step>=0&&index+step<chapters.length)book=playableBook(base,chapters[index+step].id);else{const i=books.findIndex(b=>b.id===current.id);book=playableBook(books[(i+step+books.length)%books.length])}player.pause();this.setData({book,duration:time(book.duration),position:0,formatted:'00:00',playing:false});this.updateSubtitles(0,true)},
    openQuiz() {const book=this.data.book;const pieceId=book.chapterId||(book.chapters||[])[0]?.id;if(book.id!=='peter'&&!(legacyQuizzes[pieceId]||[]).length){host.toast('这一章暂时没有小测');return}player.pause();host.go('quiz',book.id+(pieceId?':'+pieceId:''))},
    playOption(e) {const option=this.data.quizOptions[Number(e.currentTarget.dataset.index)];if(!option?.audio)return;player.pause();if(!this.optionAudio)this.optionAudio=wx.createInnerAudioContext();this.optionAudio.stop();this.optionAudio.src=option.audio;this.optionAudio.play()},
    onUnload() {if(this.optionAudio)this.optionAudio.destroy()},
    answer(e) {if(!this.data.checked)this.setData({answer:Number(e.currentTarget.dataset.index)})},
    nextQuestion() {if(this.data.answer<0){host.toast('先选择一个答案吧');return}if(!this.data.checked){this.setData({checked:true});return}const scores=[...this.data.scores,this.data.answer===this.data.question.answer?1:0];const n=this.data.questionIndex+1;if(n>=this.questions.length){const score=Math.round(scores.reduce((a,b)=>a+b,0)/this.questions.length*100);this.state.results=[{id:Date.now(),title:this.data.book.chapterTitle||this.data.book.title,score,date:new Date().toLocaleDateString()},...this.state.results];this.save();this.setData({result:true,score,scores})}else{const question=this.questions[n];this.setData({questionIndex:n,question,quizOptions:this.quizOptions(question),quizProgress:(n+1)/this.questions.length*100,answer:-1,checked:false,scores})}},
    retryQuiz() {this.setupQuiz()},
    period(e) {this.setData({period:e.currentTarget.dataset.id})}
  }
}
module.exports = { createPage }
