const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  applyVocabularyReview,
  bindPendingVocabulary,
  createVocabularyCandidates,
  createVocabularyReviewDraft,
  validateVocabularyReview
} = require('../tools/content-pipeline/vocab-review-workflow')

const sourcePackage = path.resolve(__dirname, '..', 'content', 'peter-rabbit', 'peter-rabbit-01')

function copyPackageFixture() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'tingyue-vocab-review-'))
  for (const relative of [
    'source/manifest.source.json', 'source/lexicon/evidence.json',
    'dist/cues.json', 'dist/qa-report.json', 'dist/manifest.json'
  ]) {
    const destination = path.join(target, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(sourcePackage, relative), destination)
  }
  fs.mkdirSync(path.join(target, 'review'), { recursive: true })
  return target
}

function completedVocabularyReview(packageDir) {
  const draft = createVocabularyReviewDraft(createVocabularyCandidates(packageDir))
  draft.status = 'completed'
  for (const entry of draft.entries) {
    entry.action = 'approve'
    entry.confirmed = true
    entry.senses = [{
      entryId: null,
      lemma: entry.normalized,
      partOfSpeech: 'other',
      senseNo: 1,
      phonetic: '/test/',
      definitionEn: `A reviewed meaning for ${entry.normalized}.`,
      definitionZh: `${entry.normalized} 的已审核释义。`,
      occurrenceTokenIds: entry.occurrences.map((item) => item.tokenId),
      evidenceRefs: []
    }]
  }
  draft.signoff = { reviewer: 'wzx', reviewedAt: '2026-09-21T09:00:00.000Z' }
  return draft
}

test('vocabulary candidates come from the 59 reviewed cues and cover every eligible token', (t) => {
  const packageDir = copyPackageFixture()
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))
  const candidates = createVocabularyCandidates(packageDir)
  const cues = bindPendingVocabulary(packageDir, candidates)
  const contentWords = cues.filter((cue) => cue.kind === 'content').flatMap((cue) => cue.tokens).filter((token) => token.kind === 'word')
  const clickable = contentWords.filter((token) => !token.properNoun)

  assert.equal(candidates.counts.cues, 59)
  assert.equal(candidates.counts.reviewUnits, 371)
  assert.equal(candidates.counts.clickableTokens, 909)
  assert.equal(clickable.length, 909)
  assert.ok(clickable.every((token) => token.vocabKey && token.vocabKey.endsWith(':pending:1')))
  assert.equal(cues.find((cue) => cue.id === 'c0012').tokens.find((token) => token.surface === 'cucumber').vocabKey, 'cucumber:pending:1')
  assert.equal(cues.find((cue) => cue.id === 'c0012').tokens.find((token) => token.surface === 'McGregor').vocabKey, null)
  assert.equal(cues.find((cue) => cue.id === 'c0028').tokens.find((token) => token.surface === 'work').vocabKey, 'work:pending:1')
})

test('open evidence is traceable but machine candidates cannot pass as approval', () => {
  const candidates = createVocabularyCandidates(sourcePackage)
  const asked = candidates.entries.find((entry) => entry.normalized === 'asked')
  assert.ok(candidates.counts.evidenceMatchedUnits > 300)
  assert.ok(asked.evidence.some((item) => item.ref.startsWith('oewn-2025:')))
  assert.ok(asked.evidence.some((item) => item.pronunciationSource === 'Britfone 3.0.1'))
  const validation = validateVocabularyReview(createVocabularyReviewDraft(candidates), sourcePackage)
  assert.equal(validation.valid, false)
  assert.ok(validation.errors.some((message) => message.includes('explicit human confirmation')))
  assert.ok(validation.errors.some((message) => message.includes('status must be completed')))
})

test('completed vocabulary review creates final entries without opening other release gates', (t) => {
  const packageDir = copyPackageFixture()
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))
  const review = completedVocabularyReview(packageDir)
  assert.equal(validateVocabularyReview(review, packageDir).valid, true)
  const result = applyVocabularyReview(review, packageDir)

  assert.equal(Object.keys(result.vocabulary).length, 371)
  assert.equal(result.qa.checks.vocabularyApproved, true)
  assert.equal(result.qa.checks.subtitleReviewComplete, true)
  assert.equal(result.qa.checks.humanReviewComplete, false)
  assert.equal(result.manifest.publishable, false)
  assert.ok(result.qa.blockers.every((message) => !/vocab/i.test(message)))
  const clickable = result.cues.flatMap((cue) => cue.tokens).filter((token) => token.kind === 'word' && !token.properNoun)
  assert.ok(clickable.every((token) => result.vocabulary[token.vocabKey]))
})

test('review rejects changed subtitle inputs and incomplete sense assignments', () => {
  const review = completedVocabularyReview(sourcePackage)
  review.sourceCueSha256 = '0'.repeat(64)
  review.entries[0].senses[0].occurrenceTokenIds = []
  const validation = validateVocabularyReview(review, sourcePackage)
  assert.equal(validation.valid, false)
  assert.ok(validation.errors.some((message) => message.includes('sourceCueSha256')))
  assert.ok(validation.errors.some((message) => message.includes('every occurrence')))
})

test('vocabulary workbench supports local drafts without archiving activity telemetry', () => {
  const html = fs.readFileSync(path.join(sourcePackage, 'review', 'vocab-index.html'), 'utf8')
  assert.match(html, /拆分新义项/)
  assert.match(html, /localStorage/)
  assert.doesNotMatch(html, /listenSeconds|dwellTime|activityLog/)
})
