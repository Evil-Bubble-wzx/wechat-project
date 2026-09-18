// Rebuilds the four imported story packages and mini program data from the
// immutable snapshot in content/legacy-listen-read/source/.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '../..')
const source = path.join(root, 'content/legacy-listen-read/source')
const base = path.join(root, 'content/legacy-listen-read')
const mini = path.join(root, 'miniprogram')
const stories = JSON.parse(fs.readFileSync(path.join(source, 'stories.json'), 'utf8')).books
const timings = JSON.parse(fs.readFileSync(path.join(source, 'timings.json'), 'utf8'))
const dictionaries = [
  JSON.parse(fs.readFileSync(path.join(source, 'dictionary.json'), 'utf8')),
  JSON.parse(fs.readFileSync(path.join(source, 'oz-dictionary.json'), 'utf8'))
]
const coverNames = { 'little-seed': 'little-seed.png', 'fox-star': 'fox-star.png', 'bear-picnic': 'bear-picnic.png', 'wonderful-wizard-oz': 'wonderful-wizard-oz.jpg' }
const catalog = JSON.parse(fs.readFileSync(path.join(mini, 'modules/catalog/catalog.json'), 'utf8'))
const importedIds = new Set(stories.map(book => book.id))
const allCues = {}
const vocab = {}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function tokens(text, cueId, dictionary) {
  const parts = text.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\s+|[^A-Za-z\s]+/g) || []
  return parts.map((surface, index) => {
    const token = { id: `${cueId}:t${String(index).padStart(2, '0')}`, surface, kind: /^\s+$/.test(surface) ? 'space' : /^[A-Za-z]/.test(surface) ? 'word' : 'punctuation' }
    if (token.kind === 'word') {
      const key = surface.toLowerCase().replace(/[’]/g, "'")
      token.vocabKey = key
      if (dictionary[key]) vocab[key] = dictionary[key]
    }
    return token
  })
}

const importedCatalog = stories.map((book, bookIndex) => {
  const dictionary = book.id === 'wonderful-wizard-oz' ? dictionaries[1] : dictionaries[0]
  const chapters = book.chapters.map((chapter, chapterIndex) => {
    const timing = timings[chapter.id]
    if (!timing || timing.cues.length !== chapter.sentences.length) throw new Error(`Sentence/timing mismatch: ${chapter.id}`)
    const packageDir = path.join(base, book.id, chapter.id)
    const audioFile = path.join(source, 'audio', chapter.id + '.mp3')
    if (!fs.existsSync(audioFile)) throw new Error(`Missing audio: ${chapter.id}`)
    const cues = chapter.sentences.map(([text, translation], index) => {
      const id = `c${String(index + 1).padStart(4, '0')}`
      const t = timing.cues[index]
      return { id, kind: index === 0 && chapter.id === 'oz-1' ? 'heading' : 'content', startMs: Math.round(t.start * 1000), endMs: Math.round(t.end * 1000), text, translation: translation || null, reviewStatus: 'needs_review', tokens: tokens(text, id, dictionary) }
    })
    const text = chapter.sentences.map(pair => pair[0]).join('\n') + '\n'
    const src = path.join(packageDir, 'source')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'text-original.txt'), text)
    fs.copyFileSync(audioFile, path.join(src, 'audio-original.mp3'))
    writeJson(path.join(src, 'manifest.source.json'), {
      schemaVersion: 1, bookId: book.id, pieceId: chapter.id, index: chapterIndex + 1,
      title: chapter.title, language: 'en', audio: 'source/audio-original.mp3', text: 'source/text-original.txt', rights: 'source/rights.json',
      previousSource: 'content/legacy-listen-read/source/stories.json',
      audioMetadata: { durationMs: Math.round(timing.duration * 1000), mimeType: 'audio/mpeg', sha256: hash(audioFile), sourceName: book.id === 'wonderful-wizard-oz' ? 'LibriVox chapter recording' : 'Microsoft Zira demonstration synthesis' }
    })
    writeJson(path.join(src, 'rights.json'), {
      schemaVersion: 1, pieceId: chapter.id,
      origin: book.id === 'wonderful-wizard-oz' ? 'Project Gutenberg EPUB and LibriVox OGG from the previous project' : 'Original demo story and Microsoft Zira synthesized audio from the previous project',
      sourceSnapshot: 'content/legacy-listen-read/source', releaseApproved: false,
      reviewStatus: 'needs_legal_review',
      note: 'Text, illustration, recording or synthesis rights and target jurisdiction have not been verified for commercial release.'
    })
    writeJson(path.join(packageDir, 'dist/cues.json'), cues)
    writeJson(path.join(packageDir, 'dist/manifest.json'), {
      schemaVersion: 1, pieceId: chapter.id, contentVersion: 0, status: 'needs_review', publishable: false,
      audio: { source: 'source/audio-original.mp3', durationMs: Math.round(timing.duration * 1000), sha256: hash(audioFile) },
      artifacts: { cues: 'dist/cues.json' }, counts: { cues: cues.length, words: cues.reduce((n, cue) => n + cue.tokens.filter(token => token.kind === 'word').length, 0) },
      blockers: ['Human subtitle and audio review pending.', 'Commercial rights and target-jurisdiction review pending.']
    })
    allCues[chapter.id] = cues
    const outputAudio = path.join(mini, 'assets/audio', chapter.id + '.mp3')
    fs.mkdirSync(path.dirname(outputAudio), { recursive: true })
    fs.copyFileSync(audioFile, outputAudio)
    return { id: chapter.id, title: chapter.title, zh: chapter.zh, duration: timing.duration, localAudio: `/assets/audio/${chapter.id}.mp3`, hasQuiz: chapter.quiz.length > 0 }
  })
  const cover = coverNames[book.id]
  const outputCover = path.join(mini, 'assets/covers', cover)
  fs.mkdirSync(path.dirname(outputCover), { recursive: true })
  fs.copyFileSync(path.join(source, 'covers', cover), outputCover)
  const wordCount = chapters.reduce((n, chapter) => n + allCues[chapter.id].reduce((count, cue) => count + cue.tokens.filter(token => token.kind === 'word').length, 0), 0)
  const duration = chapters.reduce((n, chapter) => n + chapter.duration, 0)
  return {
    id: book.id, title: book.title, zh: book.zh, author: book.id === 'wonderful-wizard-oz' ? 'L. Frank Baum' : 'Tingyue original story',
    series: book.id === 'wonderful-wizard-oz' ? 'Classic Stories · Chapter 1' : 'Tingyue Original',
    level: book.level, words: wordCount, pages: 0, duration, time: Math.max(1, Math.round(duration / 60)) + ' min',
    category: 'fiction', cover: '/assets/covers/' + cover, color: book.color, stock: 0,
    number: String(20001 + bookIndex), desc: book.intro, audioSource: book.id === 'wonderful-wizard-oz' ? 'LibriVox' : 'Microsoft Zira',
    narrator: book.id === 'wonderful-wizard-oz' ? 'LibriVox volunteer' : 'Microsoft Zira',
    localAudio: chapters[0].localAudio, chapters
  }
})

writeJson(path.join(mini, 'modules/catalog/catalog.json'), [...catalog.filter(book => !importedIds.has(book.id)), ...importedCatalog])
const compactCues = Object.fromEntries(Object.entries(allCues).map(([pieceId, cues]) => [pieceId, cues.map(({ tokens: _tokens, ...cue }) => cue)]))
const cuesModule = `// Generated by npm run content:legacy. Full tokens remain in each chapter's dist/cues.json.\n` +
  `const raw = ${JSON.stringify(compactCues)}\n` +
  `module.exports = Object.fromEntries(Object.entries(raw).map(([pieceId, cues]) => [pieceId, cues.map(cue => Object.assign({}, cue, { tokens: (cue.text.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\\s+|[^A-Za-z\\s]+/g) || []).map((surface, index) => ({ id: cue.id + ':t' + String(index).padStart(2, '0'), surface, kind: /^\\s+$/.test(surface) ? 'space' : /^[A-Za-z]/.test(surface) ? 'word' : 'punctuation', vocabKey: /^[A-Za-z]/.test(surface) ? surface.toLowerCase().replace(/[’]/g, "'") : null })) }))]))\n`
fs.writeFileSync(path.join(mini, 'modules/listen-read/legacy-cues-data.js'), cuesModule)
fs.writeFileSync(path.join(mini, 'modules/listen-read/legacy-vocab-data.js'), '// Generated by npm run content:legacy. Do not edit by hand.\nmodule.exports = ' + JSON.stringify(vocab) + '\n')
console.log(`Imported ${importedCatalog.length} books, ${Object.keys(allCues).length} chapters and ${Object.values(allCues).reduce((n, cues) => n + cues.length, 0)} cues.`)
