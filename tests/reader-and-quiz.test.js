const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const subtitles = require('../miniprogram/modules/listen-read/subtitles')
const legacyCues = require('../miniprogram/modules/listen-read/legacy-cues-data')
const legacyQuizzes = require('../miniprogram/modules/listen-read/legacy-quiz-data')

test('seven-line reader wraps at 40 characters and retains the last sentence in pauses', () => {
  for (const cues of Object.values(legacyCues)) {
    const layout = subtitles.prepare(cues)
    assert.ok(layout.lines.every(line => line.text.length <= 40))
    const first = subtitles.display(layout, cues, cues[0].startMs)
    assert.equal(first.rows.length, 7)
    assert.equal(first.rows[1].cueIndex, 0)
    assert.equal(first.rows[1].active, true)
    if (cues.length > 1 && cues[1].startMs > cues[0].endMs) {
      const gap = subtitles.display(layout, cues, cues[0].endMs + 1)
      assert.equal(gap.current, 0)
      assert.ok(gap.rows.some(row => row.cueIndex === 0 && row.active))
    }
  }
})

test('legacy quizzes have all option recordings in the quiz subpackage', () => {
  assert.equal(Object.values(legacyQuizzes).filter(questions => questions.length).length, 6)
  for (const questions of Object.values(legacyQuizzes)) for (const question of questions) {
    assert.equal(question.audio.length, question.options.length)
    for (const audio of question.audio) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'miniprogram', audio)))
    }
  }
})

test('quiz page selects a legacy chapter and checks its answer', () => {
  const previousWx = global.wx
  global.wx = { isBrowserPreview:true, __tingyueMode:'demo', getStorageSync: () => ({}), setStorageSync: () => {}, getWindowInfo: () => ({ statusBarHeight: 24 }) }
  try {
    const { createPage } = require('../miniprogram/ui/controller')
    const page = createPage('quiz')
    page.setData = patch => Object.assign(page.data, patch)
    page.onLoad({ id: 'little-seed:seed-2' })
    assert.equal(page.data.quizTotal, 3)
    assert.equal(page.data.quizOptions.length, 3)
    page.answer({ currentTarget: { dataset: { index: page.data.question.answer } } })
    page.nextQuestion()
    assert.equal(page.data.checked, true)
    page.nextQuestion()
    assert.equal(page.data.questionIndex, 1)
  } finally { global.wx = previousWx }
})
