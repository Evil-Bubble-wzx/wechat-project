const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  calculateListenCoverage,
  createReviewDraft,
  createReviewTranscript,
  validateReviewDocument,
  applyCorrections
} = require('../tools/content-pipeline/review-workflow')

const sourcePackage = path.resolve(__dirname, '..', 'content', 'peter-rabbit', 'peter-rabbit-01')

test('full-listen coverage treats the fractional final audio bucket as complete', () => {
  const listened = Array.from({ length: 322 }, (_, index) => index)
  assert.equal(calculateListenCoverage(listened, 322026), 1)
  assert.ok(calculateListenCoverage(listened.slice(0, 300), 322026) < 0.95)
})

function completedReview(packageDir) {
  const draft = createReviewDraft(packageDir)
  draft.status = 'completed'
  for (const decision of draft.decisions) {
    decision.action = decision.recommendation
    decision.confirmed = true
    if (decision.action === 'omitCue') decision.reason = 'Human reviewer confirmed that the recording omits this sentence.'
  }
  draft.signoff = {
    reviewer: 'Test Reviewer',
    fullListenCompleted: true,
    fullListenCoverage: 0.99,
    fullListenCompletedAt: '2026-09-21T01:00:00.000Z',
    reviewedAt: '2026-09-21T01:10:00.000Z'
  }
  return draft
}

function copyPackageFixture() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'tingyue-review-'))
  for (const relative of [
    'source/manifest.source.json', 'work/unmatched.json', 'work/cues.draft.json',
    'work/cues.aligned.json', 'dist/qa-report.json', 'dist/manifest.json'
  ]) {
    const destination = path.join(target, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(sourcePackage, relative), destination)
  }
  fs.mkdirSync(path.join(target, 'review'), { recursive: true })
  return target
}

test('subtitle review draft has 26 token decisions and 2 whole-cue decisions', () => {
  const draft = createReviewDraft(sourcePackage)
  assert.equal(draft.decisions.length, 28)
  assert.equal(draft.decisions.filter((item) => item.type === 'token').length, 26)
  assert.deepEqual(draft.decisions.filter((item) => item.type === 'omittedCue').map((item) => item.id), ['O1', 'O2'])
  assert.deepEqual(draft.decisions.filter((item) => item.type === 'omittedCue').map((item) => item.cueId), ['c0012', 'c0028'])
})

test('review transcript contains all playable cues and two omitted-cue markers', () => {
  const transcript = createReviewTranscript(sourcePackage)
  assert.equal(transcript.filter((cue) => !cue.omittedCandidate).length, 57)
  assert.deepEqual(transcript.filter((cue) => cue.omittedCandidate).map((cue) => cue.id), ['O1', 'O2'])
  assert.ok(transcript.find((cue) => cue.cueId === 'c0001').issueIds.includes('R01'))
  assert.ok(transcript.every((cue, index) => index === 0 || cue.startMs >= transcript[index - 1].startMs))
})

test('machine recommendations cannot pass as human approval', () => {
  const draft = createReviewDraft(sourcePackage)
  const result = validateReviewDocument(draft, sourcePackage)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((message) => message.includes('explicit human confirmation')))
  assert.ok(result.errors.some((message) => message.includes('signoff.reviewer')))
})

test('approved subtitle review updates its own gate but remains unpublishable', (t) => {
  const packageDir = copyPackageFixture()
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))
  const review = completedReview(packageDir)
  assert.equal(validateReviewDocument(review, packageDir).valid, true)
  const result = applyCorrections(review, packageDir)

  assert.equal(result.cues.length, 57)
  assert.ok(result.cues.every((cue) => cue.subtitleReviewStatus === 'approved'))
  assert.equal(result.qa.checks.subtitleReviewComplete, true)
  assert.equal(result.qa.checks.humanReviewComplete, false)
  assert.equal(result.manifest.publishable, false)
  assert.equal(result.qa.blockers.length, 3)
  assert.equal(result.corrections.tokenCorrections.length, 26)
  assert.equal(result.corrections.cueCorrections.length, 2)
})

test('review application supports text replacement, timing fixes and whole-cue restoration', (t) => {
  const packageDir = copyPackageFixture()
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))
  const review = completedReview(packageDir)
  const timing = review.decisions.find((item) => item.id === 'R01')
  timing.action = 'adjustTiming'
  timing.startMs = timing.originalStartMs + 10
  timing.endMs = timing.originalEndMs + 20
  const replacement = review.decisions.find((item) => item.id === 'R02')
  replacement.action = 'replaceSurface'
  replacement.replacementText = 'fir'
  const restored = review.decisions.find((item) => item.id === 'O2')
  restored.action = 'restoreCue'
  restored.actualText = 'He went back to his work.'
  restored.startMs = 164200
  restored.endMs = 167200
  restored.reason = null

  const result = applyCorrections(review, packageDir)
  const restoredCue = result.cues.find((cue) => cue.id === 'c0028')
  const replacedToken = result.cues.find((cue) => cue.id === 'c0002').tokens.find((token) => token.id === 'c0002:t31')
  assert.equal(result.cues.length, 58)
  assert.equal(restoredCue.text, 'He went back to his work.')
  assert.equal(restoredCue.tokens.map((token) => token.surface).join(''), restoredCue.text)
  assert.equal(replacedToken.surface, 'fir')
  assert.equal(result.cues.find((cue) => cue.id === 'c0001').tokens.find((token) => token.id === 'c0001:t39').startMs, timing.startMs)
  assert.equal(result.manifest.publishable, false)
})

test('exact matches cannot be changed into replacement text', () => {
  const review = completedReview(sourcePackage)
  const exact = review.decisions.find((item) => item.id === 'R01')
  exact.action = 'replaceSurface'
  exact.replacementText = 'Something else'
  const result = validateReviewDocument(review, sourcePackage)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((message) => message.includes('may not replace the surface')))
})
