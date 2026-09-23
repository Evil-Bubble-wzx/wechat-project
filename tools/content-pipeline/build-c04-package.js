const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const root = path.resolve(packageDir, '..', '..', '..')
const readJson = relative => JSON.parse(fs.readFileSync(path.join(packageDir, relative), 'utf8'))
const writeJson = (relative, value) => {
  const target = path.join(packageDir, relative)
  fs.mkdirSync(path.dirname(target), { recursive:true })
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', 'utf8')
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const metadata = readJson('source/metadata.source.json')
const quiz = readJson('source/quiz.source.json')
const cues = readJson('dist/cues.json')
const manifest = readJson('dist/manifest.json')
const qa = readJson('dist/qa-report.json')
const cueMap = new Map(cues.map(cue => [cue.id, cue]))

if (metadata.workId !== quiz.workId || metadata.pieceId !== quiz.pieceId) throw new Error('Metadata and Quiz IDs do not match')
if (metadata.contentVersion !== 1 || quiz.contentVersion !== 1) throw new Error('C-04 candidate must be contentVersion 1')
if (metadata.level !== null || metadata.pageCount !== null) throw new Error('Unsupported level/pageCount must remain null')
if (quiz.mode !== 'fixed_order' || quiz.questions.length !== 10) throw new Error('C-04 requires a fixed ten-question Quiz')
if (quiz.audioOptionsIncluded) throw new Error('Quiz option audio is out of C-04 scope')
if (quiz.masteryFeedbackPercent !== 80 || quiz.blocksContent) throw new Error('80% is feedback only and must not block content')

const ids = new Set()
for (const question of quiz.questions) {
  if (ids.has(question.id)) throw new Error(`Duplicate question id: ${question.id}`)
  ids.add(question.id)
  if (!/^PRQ-\d{3}$/.test(question.id)) throw new Error(`Invalid question id: ${question.id}`)
  if (question.options.length !== 3 || !question.options.every(option => option.includes(' / '))) throw new Error(`${question.id} must have three bilingual options`)
  if (!Number.isInteger(question.answer) || question.answer < 0 || question.answer >= question.options.length) throw new Error(`${question.id} has an invalid answer`)
  if (!question.q || !question.zh || !question.explanation.includes(' / ')) throw new Error(`${question.id} is not fully bilingual`)
  const evidenceText = question.sourceCueIds.map(id => {
    const cue = cueMap.get(id)
    if (!cue || cue.kind !== 'content') throw new Error(`${question.id} references missing/non-content cue ${id}`)
    return cue.text
  }).join(' ')
  for (const fragment of question.evidenceQuoteFragments) {
    if (!evidenceText.includes(fragment)) throw new Error(`${question.id} evidence fragment not found: ${fragment}`)
  }
}

writeJson('dist/metadata.json', Object.assign({}, metadata, { source:'source/metadata.source.json' }))
writeJson('dist/quiz.json', Object.assign({}, quiz, { source:'source/quiz.source.json' }))
writeJson('review/c04-review.json', {
  schemaVersion:1,
  workId:metadata.workId,
  pieceId:metadata.pieceId,
  contentVersion:metadata.contentVersion,
  status:'DONE_AI_ASSISTED',
  reviewMethod:'ai_assisted_full_review',
  authorizedBy:'wzx',
  reviewedBy:'wzx with authorized AI assistance',
  reviewedOn:'2026-09-22',
  humanReviewComplete:false,
  metadataDecisions:{ unsupportedLevelRemoved:true, unsupportedPageCountRemoved:true, editionSeparatedFromSeries:true, internalNumberLabeled:true },
  quizDecisions:{ questionCount:quiz.questions.length, fixedOrder:true, evidenceLinked:true, bilingual:true, masteryFeedbackPercent:80, blocksContent:false, optionAudioIncluded:false }
})

const questionModule = [
  '// Generated from content/peter-rabbit/peter-rabbit-01/dist/quiz.json.',
  '// Run the C-04 builder instead of editing this file.',
  `module.exports = ${JSON.stringify({schemaVersion:quiz.schemaVersion,workId:quiz.workId,pieceId:quiz.pieceId,contentVersion:quiz.contentVersion,quizVersion:quiz.quizVersion,mode:quiz.mode,masteryFeedbackPercent:quiz.masteryFeedbackPercent,blocksContent:quiz.blocksContent,questions:quiz.questions}, null, 2)}`,
  ''
].join('\n')
const modulePath = path.join(root, 'miniprogram/modules/listen-read/peter-quiz-data.js')
fs.mkdirSync(path.dirname(modulePath), { recursive:true })
fs.writeFileSync(modulePath, questionModule, 'utf8')

const assets = { audio:'source/audio-original.mp3', cues:'dist/cues.json', vocabulary:'dist/vocab.json', metadata:'dist/metadata.json', quiz:'dist/quiz.json' }
const hashes = Object.fromEntries(Object.entries(assets).map(([key,relative]) => [key, sha256(path.join(packageDir, relative))]))
hashes.cover = sha256(path.join(root, 'miniprogram/assets/peter.png'))

manifest.contentVersion = 1
manifest.workId = metadata.workId
manifest.legacyClientId = metadata.legacyClientId
manifest.artifacts = Object.assign({}, manifest.artifacts, { metadata:'dist/metadata.json', quiz:'dist/quiz.json', c04Review:'review/c04-review.json' })
manifest.assetHashes = hashes
manifest.metadataReview = metadata.review
manifest.quizReview = Object.assign({}, quiz.review, { questionCount:quiz.questions.length, quizVersion:quiz.quizVersion })
manifest.blockers = manifest.blockers.filter(item => !item.includes('Formal metadata, Quiz') && !item.includes('approved vocabulary is not yet wired'))
manifest.publishable = false
manifest.status = 'needs_review'
writeJson('dist/manifest.json', manifest)

qa.checks.metadataApproved = true
qa.checks.quizApproved = true
qa.checks.humanReviewComplete = false
qa.checks.rightsReleaseApproved = false
qa.metadataReview = metadata.review
qa.quizReview = Object.assign({}, quiz.review, { questionCount:quiz.questions.length, quizVersion:quiz.quizVersion })
qa.blockers = qa.blockers.filter(item => !item.includes('Formal metadata, Quiz') && !item.includes('approved vocabulary is not yet wired'))
qa.publishable = false
qa.status = 'needs_review'
writeJson('dist/qa-report.json', qa)

console.log(JSON.stringify({ workId:metadata.workId, pieceId:metadata.pieceId, contentVersion:1, questions:quiz.questions.length, hashes, publishable:false }, null, 2))
