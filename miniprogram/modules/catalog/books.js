// Catalog remains local until the content API is connected. Peter Rabbit Quiz is
// generated from the C-04 reviewed, cue-linked source package.
const books = require('./catalog-data')
const questions = require('../listen-read/peter-quiz-data')
module.exports = { books, questions }
