const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
let memory = {}
global.wx = { getStorageSync: () => JSON.parse(JSON.stringify(memory)), setStorageSync: (key, value) => { memory = JSON.parse(JSON.stringify(value)) }, showToast() {}, navigateTo() {}, redirectTo() {}, switchTab() {} }
const content = require('../modules/listen-read/services/content')
const subtitles = require('../modules/listen-read/services/subtitles')
const store = require('../modules/listen-read/services/store')
const books = content.listBooks()
assert.equal(books.length, 4)
for (const book of books) {
  assert(fs.existsSync(path.join(root, book.cover)))
  assert(content.canRead(book.id, book.chapters[0].id))
  if (book.chapters.length > 1 && !book.free) assert(!content.canRead(book.id, book.chapters[1].id))
  for (const ch of book.chapters) {
    const piece = content.chapterData(book.id, ch.id)
    assert(fs.existsSync(path.join(root, piece.audio)))
    assert(piece.duration > 1)
    assert.equal(piece.cues.length, ch.sentences.length)
    const layout = subtitles.prepare(piece.cues)
    piece.cues.forEach((cue, i) => {
      const lines = layout.lines.slice(layout.starts[i], layout.starts[i] + layout.counts[i])
      assert(lines.every(line => line.text.length <= 40), 'subtitle exceeds 40 characters')
      assert.equal(lines.map(line => line.text).join(' '), cue.text.replace(/\s+/g, ' ').trim())
    })
    let previous = 0
    piece.cues.forEach(cue => {
      if (book.free) assert(cue.start >= previous)
      else assert(Math.abs(cue.start - previous) < 0.001)
      assert(cue.end > cue.start)
      assert.equal(cue.tokens.map(t => t.value).join(''), cue.text)
      for (const token of cue.tokens.filter(t => t.word && book.hasDictionary !== false)) {
        assert.notEqual(content.meaning(token.value, book.id).zh, '这个词暂未收录', token.value)
      }
      previous = cue.end
    })
    if (book.free) assert(previous <= piece.duration)
    else assert(Math.abs(previous - piece.duration) < 0.001)
    ch.quiz.forEach((question, qi) => {
      assert(question.options.length >= 3)
      assert(question.answer >= 0 && question.answer < question.options.length)
      assert(question.explanation)
      question.options.forEach((_, oi) => assert(fs.existsSync(path.join(root, 'assets/quiz-audio', `${ch.id}-${qi}-${oi}.mp3`))))
    })
  }
}
assert(store.unlock('little-seed'))
store.unlock('little-seed')
assert.equal(store.read().purchased.length, 1)
assert(content.canRead('little-seed', 'seed-2'))
assert(!content.canRead('fox-star', 'fox-2'))
store.progress('little-seed', 'seed-1', 2, 10, 2)
store.progress('little-seed', 'seed-1', 4, 10, 2)
assert.equal(store.read().progress['seed-1'].listened, 4)
assert.equal(store.read().last.pieceId, 'seed-1')
store.progress('little-seed', 'seed-1', 10, 10, 6)
store.progress('little-seed', 'seed-1', 0, 10, 0)
assert.equal(store.stats().finished, 1)
assert.equal(store.stats().seconds, 10)
store.saveWord({ key: 'test:seed', surface: 'seed' })
store.saveWord({ key: 'test:seed', surface: 'seed' })
assert.equal(store.stats().words, 1)
store.removeWord('test:seed')
assert.equal(store.stats().words, 0)
assert.equal(store.read().auth, null)
assert.equal(store.simulateFriendLogin(), false)
assert(store.login('phone', '13800138000'))
assert.equal(store.read().auth.label, '138****8000')
assert(store.simulateFriendLogin())
assert.equal(store.simulateFriendLogin(), false)
const coupon = store.availableCoupon(12)
assert.equal(coupon.amount, 5)
assert.equal(store.availableCoupon(11), null)
store.useCoupon(coupon.id)
assert.equal(store.availableCoupon(12), null)
store.logout()
assert.equal(store.read().auth, null)

function loadPage(name) {
  let def
  global.Page = value => { def = value }
  const file = path.join(root, 'modules/listen-read/pages', name, 'index.js')
  delete require.cache[require.resolve(file)]
  require(file)
  const instance = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(value) { Object.assign(this.data, value) } })
  const markup = fs.readFileSync(file.replace('.js', '.wxml'), 'utf8')
  for (const binding of markup.matchAll(/(?:bind:?|catch:?)(?:tap|input|change|changing|open)="([A-Za-z][A-Za-z0-9]*)"/g)) assert.equal(typeof instance[binding[1]], 'function', name + ':' + binding[1])
  return instance
}
for (const name of ['home','shelf','profile','book','reader','quiz','vocab','login','invite','coupons']) loadPage(name)
const ozReader = loadPage('reader')
ozReader.setData({ chapter: content.chapterData('wonderful-wizard-oz', 'oz-1'), book: content.getBook('wonderful-wizard-oz') })
for (const [time, expected] of [[0, -1], [21, 0], [22.8, 0], [23.39, 0], [23.4, 1], [24, 1], [384.2, 53], [384.63, -1]]) {
  ozReader.sync(time)
  assert.equal(ozReader.data.current, expected, 'Oz active line at ' + time)
}
ozReader.sync(22)
const titleWindow = ozReader.data.subtitleRows[1].text
ozReader.sync(22.8)
assert.equal(ozReader.data.subtitleRows[1].text, titleWindow, 'gap should retain prior sentence window')
assert(ozReader.data.subtitleRows[1].active, 'gap should retain prior highlight')
assert.equal(ozReader.data.subtitleRows.length, 7)
ozReader.sync(23.4)
assert.equal(ozReader.data.subtitleRows[1].cueIndex, 1)
assert(ozReader.data.subtitleRows[1].active)
const shortCue = ozReader.data.chapter.cues[1]
const shortStart = ozReader.data.subtitleRows[1].text
ozReader.sync(shortCue.start + (shortCue.end - shortCue.start) * .8)
assert.equal(ozReader.data.subtitleRows[1].text, shortStart, 'short sentence must stay in place')
const longCue = ozReader.data.chapter.cues[16]
ozReader.sync(longCue.start)
const firstLine = ozReader.data.subtitleRows[1].text
ozReader.sync(longCue.start + (longCue.end - longCue.start) * .4)
assert.equal(ozReader.data.subtitleRows[1].text, firstLine, 'long sentence should begin without moving')
ozReader.sync(longCue.start + (longCue.end - longCue.start) * .8)
assert.notEqual(ozReader.data.subtitleRows[1].text, firstLine)
ozReader.bookId = 'wonderful-wizard-oz'
ozReader.pieceId = 'oz-1'
ozReader.player = { pause() {} }
ozReader.wordTap({ currentTarget: { dataset: { word: 'Dorothy', line: 1 } } })
assert.equal(ozReader.data.word.zh, '多萝西（人名）')
assert(ozReader.data.word.sentence.startsWith('Dorothy lived'))
ozReader.wordTap({ currentTarget: { dataset: { word: 'trap-door', line: 35 } } })
assert.equal(ozReader.data.word.zh, '活板门')
assert(ozReader.data.word.sentence.includes('trap-door'))
const home = loadPage('home')
home.onShow()
home.filter({ currentTarget: { dataset: { value: 'L2 进阶' } } })
assert.equal(home.data.books.length, 2)
home.search({ detail: { value: 'no-such-book' } })
assert.equal(home.data.books.length, 0)
const quiz = loadPage('quiz')
quiz.onLoad({ book: 'little-seed', piece: 'seed-1' })
quiz.submit()
assert(!quiz.data.checked)
for (let i = 0; i < 3; i++) {
  quiz.select({ currentTarget: { dataset: { index: i } } })
  quiz.submit(); quiz.submit()
  quiz.next()
}
assert(quiz.data.done)
assert.equal(quiz.data.correct, 3)
assert.equal(quiz.data.score, 100)
assert.equal(store.stats().accuracy, 100)
quiz.retry()
assert.equal(quiz.data.correct, 0)
assert.equal(quiz.data.results.length, 0)
assert.equal(quiz.data.selected, -1)
assert.equal(fs.readdirSync(path.join(root, 'assets/quiz-audio')).length, 54)
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
for (const page of app.pages) for (const ext of ['js', 'json', 'wxml', 'wxss']) assert(fs.existsSync(path.join(root, page + '.' + ext)))
for (const item of app.tabBar.list) for (const field of ['iconPath','selectedIconPath']) assert(fs.existsSync(path.join(root, item[field])))
console.log('PASS: routes, handlers, story and 54 option recordings, access gates, mock login, one-time invite coupon, persistence and quiz scoring.')
