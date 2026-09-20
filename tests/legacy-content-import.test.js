const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')
const imported = JSON.parse(fs.readFileSync(path.join(root, 'content/legacy-listen-read/source/stories.json'), 'utf8')).books
const timings = JSON.parse(fs.readFileSync(path.join(root, 'content/legacy-listen-read/source/timings.json'), 'utf8'))
const catalog = require('../miniprogram/modules/catalog/books').books
const runtimeCues = require('../miniprogram/modules/listen-read/legacy-cues-data')

test('all imported chapters retain their text, timing and exact audio bytes', () => {
  assert.equal(imported.length, 4)
  assert.equal(imported.reduce((n, book) => n + book.chapters.length, 0), 7)
  for (const book of imported) {
    const listed = catalog.find(item => item.id === book.id)
    assert.ok(listed)
    assert.equal(listed.chapters.length, book.chapters.length)
    for (const chapter of book.chapters) {
      const packageDir = path.join(root, 'content/legacy-listen-read', book.id, chapter.id)
      const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'dist/manifest.json'), 'utf8'))
      const cues = JSON.parse(fs.readFileSync(path.join(packageDir, 'dist/cues.json'), 'utf8'))
      const sourceAudio = fs.readFileSync(path.join(packageDir, 'source/audio-original.mp3'))
      const playableAudio = fs.readFileSync(path.join(root, 'miniprogram/assets/audio', chapter.id + '.mp3'))
      assert.equal(manifest.publishable, false)
      assert.equal(crypto.createHash('sha256').update(sourceAudio).digest('hex'), manifest.audio.sha256)
      assert.deepEqual(playableAudio, sourceAudio)
      assert.equal(cues.length, chapter.sentences.length)
      assert.equal(cues.length, timings[chapter.id].cues.length)
      assert.equal(runtimeCues[chapter.id].length, cues.length)
      for (const [index, cue] of cues.entries()) {
        assert.equal(cue.text, chapter.sentences[index][0])
        assert.equal(cue.startMs, Math.round(timings[chapter.id].cues[index].start * 1000))
        assert.equal(cue.endMs, Math.round(timings[chapter.id].cues[index].end * 1000))
        assert.equal(cue.tokens.map(token => token.surface).join(''), cue.text)
        assert.equal(runtimeCues[chapter.id][index].tokens.map(token => token.surface).join(''), cue.text)
      }
    }
  }
})

test('player route selects the requested chapter and its word card', () => {
  const previousWx = global.wx
  global.wx = { getStorageSync: () => ({}), getWindowInfo: () => ({ statusBarHeight: 24 }) }
  try {
    const { createPage } = require('../miniprogram/ui/controller')
    const page = createPage('player')
    page.setData = patch => Object.assign(page.data, patch)
    page.onLoad({ id: 'little-seed:seed-2' })
    assert.equal(page.data.book.chapterId, 'seed-2')
    assert.equal(page.data.book.localAudio, '/assets/audio/seed-2.mp3')
    assert.equal(page.data.duration, '00:10')
    const firstCue = runtimeCues['seed-2'][0]
    page.setData({ activeCue: firstCue })
    const firstWord = firstCue.tokens.find(token => token.kind === 'word')
    page.word({ currentTarget: { dataset: { word: firstWord.surface, vocabKey: firstWord.vocabKey } } })
    assert.equal(page.data.selectedWord.surface, firstWord.surface)
    assert.notEqual(page.data.selectedWord.definitionZh, '释义待审核')
  } finally { global.wx = previousWx }
})
