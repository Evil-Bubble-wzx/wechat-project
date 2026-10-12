// Bundled guest/Demo content. Authenticated production pages use remote-catalog
// and verified version bundles; Peter Quiz is generated from the C-04 source.
const books = require('./catalog-data')
const quizPackage = require('../listen-read/peter-quiz-data')
const questions = quizPackage.questions
module.exports = { books, questions, quizPackage }
