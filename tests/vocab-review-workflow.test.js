const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  applyVocabularyReview,
  bindPendingVocabulary,
  createVocabularyCandidates,
  createAuthorizedVocabularyReview,
  createPrefilledVocabularyReview,
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
  const reviewable = contentWords.filter((token) => !token.properNoun || token.reviewStatus === 'approved_exclusion')

  assert.equal(candidates.counts.cues, 59)
  assert.equal(candidates.counts.reviewUnits, 371)
  assert.equal(candidates.counts.clickableTokens, 909)
  assert.equal(reviewable.length, 909)
  assert.equal(clickable.length, 906)
  assert.ok(clickable.every((token) => token.vocabKey && token.vocabKey.endsWith(':pending:1')))
  assert.equal(contentWords.filter((token) => token.reviewStatus === 'approved_exclusion').length, 3)
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

test('machine prefill covers every review unit but remains unapproved', () => {
  const prefilled = createPrefilledVocabularyReview(createVocabularyCandidates(sourcePackage))
  assert.equal(prefilled.counts.prefilledUnits, 371)
  assert.equal(prefilled.counts.completePrefillUnits, 371)
  assert.equal(prefilled.entries.every((entry) => entry.confirmed === false), true)
  assert.deepEqual(prefilled.entries.filter((entry) => entry.action === 'excludeProperNoun').map((entry) => entry.normalized).sort(), ['benjamin', "mcgregor's"])
  const about = prefilled.entries.find((entry) => entry.normalized === 'about')
  assert.equal(about.senses.length, 2)
  assert.deepEqual(about.senses.map((sense) => sense.partOfSpeech), ['adverb', 'preposition'])
  assert.equal(new Set(about.senses.flatMap((sense) => sense.occurrenceTokenIds)).size, about.occurrences.length)
  const validation = validateVocabularyReview(prefilled, sourcePackage)
  assert.equal(validation.valid, false)
  assert.ok(validation.errors.some((message) => message.includes('explicit human confirmation')))

  const reviewed = structuredClone(prefilled)
  reviewed.status = 'completed'
  reviewed.entries.forEach((entry) => { entry.confirmed = true })
  reviewed.signoff = { reviewer: 'wzx', reviewedAt: '2026-09-22T09:00:00.000Z' }
  assert.equal(validateVocabularyReview(reviewed, sourcePackage).valid, true)
})

test('authorized AI-assisted full review is traceable, complete and does not claim manual inspection', () => {
  const review = createAuthorizedVocabularyReview(createVocabularyCandidates(sourcePackage), {
    reviewer: 'wzx', reviewedAt: '2026-09-22T10:00:00.000Z'
  })
  assert.equal(validateVocabularyReview(review, sourcePackage).valid, true)
  assert.equal(review.entries.length, 371)
  assert.equal(review.entries.every((entry) => entry.confirmed), true)
  assert.equal(review.signoff.reviewMethod, 'ai_assisted_full_review')
  assert.match(review.audit.statement, /does not claim that wzx personally inspected every item/)
  assert.equal(review.entries.find((entry) => entry.normalized === 'buns').senses[0].definitionEn, 'small round bread rolls')
  assert.equal(review.entries.find((entry) => entry.normalized === 'came').senses[0].partOfSpeech, 'verb')
  assert.equal(review.entries.find((entry) => entry.normalized === 'rake').senses[0].definitionZh, '耙子')
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
  assert.equal(validateVocabularyReview(review, packageDir).valid, true)
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
  assert.match(html, /机器预填/)
  assert.match(html, /prefillVersion/)
  assert.match(html, /localStorage/)
  assert.doesNotMatch(html, /listenSeconds|dwellTime|activityLog/)
})
