const path = require('node:path')
const {
  createAuthorizedVocabularyReview,
  createVocabularyCandidates,
  validateVocabularyReview,
  writeJson
} = require('./vocab-review-workflow')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const reviewer = process.argv[3] || 'wzx'
const output = path.join(packageDir, 'review', 'vocab-decisions.completed.json')
const document = createAuthorizedVocabularyReview(createVocabularyCandidates(packageDir), { reviewer })
const validation = validateVocabularyReview(document, packageDir)
if (!validation.valid) throw new Error(`Generated review is invalid:\n${validation.errors.join('\n')}`)
writeJson(output, document)
console.log(JSON.stringify({
  output,
  reviewer,
  method: document.audit.method,
  reviewedUnits: document.audit.reviewedUnits,
  reviewedOccurrenceTokens: document.audit.reviewedOccurrenceTokens,
  lowConfidenceReviewIds: document.audit.lowConfidenceReviewIds
}, null, 2))
