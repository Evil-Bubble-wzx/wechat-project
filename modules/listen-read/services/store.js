const host = require('./host')
function read() {
  return Object.assign({ purchased: [], progress: {}, words: {}, scores: {}, last: null }, host.read())
}
function update(fn) {
  const state = read()
  fn(state)
  try { host.write(state); return true } catch (e) {
    wx.showToast({ title: '本机存储不足，请清理后重试', icon: 'none' }); return false
  }
}
function owns(id) { return read().purchased.indexOf(id) !== -1 }
function unlock(id) { return update(s => { if (s.purchased.indexOf(id) === -1) s.purchased.push(id) }) }
function progress(bookId, pieceId, seconds, duration, listened) {
  return update(s => {
    const old = s.progress[pieceId] || {}
    s.progress[pieceId] = { bookId, pieceId, seconds, duration, completed: !!old.completed || seconds >= duration - 0.35, listened: (old.listened || 0) + (listened || 0) }
    s.last = { bookId, pieceId }
  })
}
function saveWord(word) { return update(s => { s.words[word.key] = word }) }
function removeWord(key) { return update(s => { delete s.words[key] }) }
function score(pieceId, correct, total) { return update(s => { s.scores[pieceId] = { correct, total, at: Date.now() } }) }
function stats() {
  const s = read(), p = Object.keys(s.progress).map(k => s.progress[k]), q = Object.keys(s.scores).map(k => s.scores[k])
  const total = q.reduce((n, x) => n + x.total, 0)
  return { books: s.purchased.length, words: Object.keys(s.words).length, finished: p.filter(x => x.completed).length,
    seconds: Math.round(p.reduce((n, x) => n + (x.listened || 0), 0)), quizzes: q.length,
    accuracy: total ? Math.round(q.reduce((n, x) => n + x.correct, 0) / total * 100) : 0 }
}
module.exports = { read, owns, unlock, progress, saveWord, removeWord, score, stats }
