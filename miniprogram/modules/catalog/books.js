// Catalog remains local until the content API is connected. Peter Rabbit Quiz is
// generated from the C-04 reviewed, cue-linked source package.
const books = require('./catalog-data')
const quizPackage = require('../listen-read/peter-quiz-data')
const questions = quizPackage.questions
module.exports = { books, questions, quizPackage }
