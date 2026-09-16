const catalog = require('../content/stories')
const timings = require('../content/timings')
const dictionary = require('../content/dictionary')
const store = require('./store')
function time(value) { const s = Math.max(0, Math.floor(value || 0)); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2) }
function getBook(id) { return catalog.books.find(book => book.id === id) }
function getChapter(bookId, pieceId) { const book = getBook(bookId); return book && book.chapters.find(ch => ch.id === pieceId) }
function canRead(bookId, pieceId) { const book = getBook(bookId); return !!book && (book.chapters[0].id === pieceId || store.owns(bookId)) }
function listBooks() {
  return catalog.books.map(book => {
    const seconds = book.chapters.reduce((n, ch) => n + timings[ch.id].duration, 0)
    return Object.assign({}, book, { duration: time(seconds), owned: store.owns(book.id), chapterCount: book.chapters.length })
  })
}
function chapterData(bookId, pieceId) {
  const ch = getChapter(bookId, pieceId)
  if (!ch) return null
  const timing = timings[pieceId]
  const cues = ch.sentences.map((s, i) => ({ start: timing.cues[i].start, end: timing.cues[i].end, text: s[0], zh: s[1],
    tokens: s[0].split(/([A-Za-z]+(?:'[A-Za-z]+)?)/).filter(Boolean).map((v, j) => ({ id: j, value: v, word: /^[A-Za-z]/.test(v), key: v.toLowerCase() })) }))
  return Object.assign({}, ch, { cues, duration: timing.duration, audio: '/assets/audio/' + pieceId + '.wav' })
}
function meaning(word) { return dictionary[word.toLowerCase()] || { lemma: word, ph: '', pos: '', zh: '这个词暂未收录', en: 'Try reading the sentence together.' } }
module.exports = { time, getBook, getChapter, canRead, listBooks, chapterData, meaning }
