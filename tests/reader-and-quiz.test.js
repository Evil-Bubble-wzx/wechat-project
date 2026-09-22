const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const subtitles = require('../miniprogram/modules/listen-read/subtitles')
const legacyCues = require('../miniprogram/modules/listen-read/legacy-cues-data')
const legacyQuizzes = require('../miniprogram/modules/listen-read/legacy-quiz-data')
const peterCues = require('../miniprogram/modules/listen-read/cues-data')['peter-rabbit-01']
const peterVocab = require('../miniprogram/modules/listen-read/peter-vocab-data')
const { questions: peterQuestions, books } = require('../miniprogram/modules/catalog/books')

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

test('Peter Rabbit uses ten bilingual, evidence-linked comprehension questions', () => {
  assert.equal(peterQuestions.length, 10)
  assert.equal(new Set(peterQuestions.map(question => question.id)).size, 10)
  assert.equal(new Set(peterQuestions.map(question => question.q)).size, 10)
  for (const question of peterQuestions) {
    assert.match(question.id, /^PRQ-\d{3}$/)
    assert.ok(question.sourceCueIds.length >= 1)
    assert.equal(question.difficulty, 'basic_comprehension')
    assert.ok(question.q.length > 10)
    assert.ok(question.zh.length > 5)
    assert.equal(question.options.length, 3)
    assert.ok(question.options.every(option => option.includes(' / ')))
    assert.ok(Number.isInteger(question.answer) && question.answer >= 0 && question.answer < question.options.length)
    assert.ok(question.explanation.includes(' / '))
  }
  const peter = books.find(book => book.id === 'peter-rabbit')
  assert.equal(peter.workId, 'peter-rabbit')
  assert.equal(peter.pieceId, 'peter-rabbit-01')
  assert.equal(peter.editionLabel, 'Peter Rabbit Public-Domain Edition')
  assert.equal(peter.level, null)
  assert.equal(peter.pages, null)
  assert.ok(peter.audioUrl.includes('thetaleofpeterrabbitandothers_2008_librivox'))
})

test('Peter Rabbit player resolves every reviewed contextual word card and preserves playback intent', () => {
  const clickable = peterCues.flatMap(cue => cue.tokens).filter(token => token.kind === 'word' && token.vocabKey)
  assert.equal(Object.keys(peterVocab).length, 358)
  assert.equal(clickable.length, 906)
  assert.ok(clickable.every(token => peterVocab[token.vocabKey]))
  assert.notEqual(peterVocab['about:adverb:1'].definitionEn, peterVocab['about:preposition:2'].definitionEn)
  const layout = subtitles.prepare(peterCues)
  assert.equal(layout.lines.filter(line => line.cueIndex === 0).flatMap(line => line.tokens).filter(token => token.vocabKey).length, 0)
  const firstContentKeys = layout.lines.filter(line => line.cueIndex === peterCues.findIndex(cue => cue.id === 'c0001')).flatMap(line => line.tokens).map(token => token.vocabKey).filter(Boolean)
  assert.ok(firstContentKeys.includes('once:adverb:1'))
  assert.ok(firstContentKeys.includes('be:auxiliary:1'))

  const previousWx = global.wx
  const player = require('../miniprogram/modules/listen-read/player')
  const previousPause = player.pause
  const previousResume = player.resume
  let pauses = 0, resumes = 0
  player.pause = () => { pauses++ }
  player.resume = () => { resumes++ }
  global.wx = { isBrowserPreview:true, getStorageSync: () => ({}), setStorageSync: () => {}, getWindowInfo: () => ({ statusBarHeight:24 }), showToast:() => {} }
  try {
    const { createPage } = require('../miniprogram/ui/controller')
    const page = createPage('player')
    page.setData = patch => Object.assign(page.data, patch)
    page.onLoad({ id:'peter-rabbit' })
    const cueIndex = peterCues.findIndex(cue => cue.id === 'c0001')
    const token = peterCues[cueIndex].tokens.find(item => item.vocabKey === 'once:adverb:1')
    page.setData({ playing:true })
    page.word({ currentTarget:{ dataset:{ word:token.surface, vocabKey:token.vocabKey, cueIndex } } })
    assert.equal(pauses, 1)
    assert.equal(page.data.selectedWord.definitionZh, peterVocab[token.vocabKey].definitionZh)
    assert.equal(page.data.selectedWord.example, peterCues[cueIndex].text)
    page.closeSheet()
    assert.equal(resumes, 1)
    assert.equal(page.data.playing, true)

    page.setData({ playing:false })
    page.word({ currentTarget:{ dataset:{ word:token.surface, vocabKey:token.vocabKey, cueIndex } } })
    page.closeSheet()
    assert.equal(resumes, 1)
  } finally {
    player.pause = previousPause
    player.resume = previousResume
    global.wx = previousWx
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
