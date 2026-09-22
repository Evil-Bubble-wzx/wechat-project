const path = require('node:path')
const { applyVocabularyReview, readJson, validateVocabularyReview } = require('./vocab-review-workflow')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const decisionsPath = path.resolve(process.argv[3] || path.join(packageDir, 'review', 'vocab-decisions.completed.json'))
const checkOnly = process.argv.includes('--check')
const document = readJson(decisionsPath)
const validation = validateVocabularyReview(document, packageDir)

if (!validation.valid) {
  console.error(`Vocabulary review is incomplete or invalid (${validation.errors.length} issue(s)):`)
  for (const error of validation.errors) console.error(`- ${error}`)
  process.exitCode = 1
} else if (checkOnly) {
  console.log(`Vocabulary review is valid: ${validation.expectedCount} review units and an authorized editorial sign-off.`)
} else {
  const result = applyVocabularyReview(document, packageDir)
  console.log(JSON.stringify({
    pieceId: document.pieceId,
    vocabularyReview: result.qa.vocabularyReview,
    finalEntryCount: Object.keys(result.vocabulary).length,
    humanReviewComplete: result.qa.checks.humanReviewComplete,
    publishable: result.manifest.publishable,
    remainingBlockers: result.qa.blockers
  }, null, 2))
}
