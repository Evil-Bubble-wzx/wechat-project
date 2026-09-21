const path = require('node:path')
const { applyCorrections, readJson, validateReviewDocument } = require('./review-workflow')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const decisionsPath = path.resolve(process.argv[3] || path.join(packageDir, 'review', 'review-decisions.completed.json'))
const checkOnly = process.argv.includes('--check')
const document = readJson(decisionsPath)
const validation = validateReviewDocument(document, packageDir)

if (!validation.valid) {
  console.error(`Review is incomplete or invalid (${validation.errors.length} issue(s)):`)
  for (const error of validation.errors) console.error(`- ${error}`)
  process.exitCode = 1
} else if (checkOnly) {
  console.log(`Review is valid: ${validation.expectedCount} decisions and full-listen sign-off.`)
} else {
  const result = applyCorrections(document, packageDir)
  console.log(JSON.stringify({
    pieceId: document.pieceId,
    subtitleReview: result.qa.subtitleReview,
    cueCount: result.cues.length,
    publishable: result.manifest.publishable,
    remainingBlockers: result.qa.blockers
  }, null, 2))
}
