const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
let memory = {}
global.wx = { getStorageSync: () => JSON.parse(JSON.stringify(memory)), setStorageSync: (key, value) => { memory = JSON.parse(JSON.stringify(value)) }, showToast() {}, navigateTo() {}, redirectTo() {}, switchTab() {} }
const content = require('../modules/listen-read/services/content')
const store = require('../modules/listen-read/services/store')
const books = content.listBooks()
assert.equal(books.length, 3)
for (const book of books) {
  assert(fs.existsSync(path.join(root, book.cover)))
  assert(content.canRead(book.id, book.chapters[0].id))
  assert(!content.canRead(book.id, book.chapters[1].id))
  for (const ch of book.chapters) {
    const piece = content.chapterData(book.id, ch.id)
    assert(fs.existsSync(path.join(root, piece.audio)))
    assert(piece.duration > 1)
    assert.equal(piece.cues.length, ch.sentences.length)
    let previous = 0
    piece.cues.forEach(cue => {
      assert(Math.abs(cue.start - previous) < 0.001)
      assert(cue.end > cue.start)
      assert.equal(cue.tokens.map(t => t.value).join(''), cue.text)
      for (const token of cue.tokens.filter(t => t.word)) {
        assert.notEqual(content.meaning(token.value).zh, '这个词暂未收录', token.value)
      }
      previous = cue.end
    })
    assert(Math.abs(previous - piece.duration) < 0.001)
    for (const question of ch.quiz) {
      assert(question.options.length >= 3)
      assert(question.answer >= 0 && question.answer < question.options.length)
      assert(question.explanation)
    }
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
for (const name of ['home','shelf','profile','book','reader','quiz','vocab']) loadPage(name)
const home = loadPage('home')
home.onShow()
home.filter({ currentTarget: { dataset: { value: 'L2 进阶' } } })
assert.equal(home.data.books.length, 1)
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
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
for (const page of app.pages) for (const ext of ['js', 'json', 'wxml', 'wxss']) assert(fs.existsSync(path.join(root, page + '.' + ext)))
for (const item of app.tabBar.list) for (const field of ['iconPath','selectedIconPath']) assert(fs.existsSync(path.join(root, item[field])))
console.log('PASS: routes, handlers, assets, 6 audio manifests, all sentence tokens, dictionary coverage, access gates, persistence, filtering and quiz scoring.')
