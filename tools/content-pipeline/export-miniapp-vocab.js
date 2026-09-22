const fs = require('node:fs')
const path = require('node:path')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const outputPath = path.resolve(process.argv[3] || 'miniprogram/modules/listen-read/peter-vocab-data.js')
const readJson = relative => JSON.parse(fs.readFileSync(path.join(packageDir, relative), 'utf8'))
const writeJson = (relative, value) => fs.writeFileSync(path.join(packageDir, relative), JSON.stringify(value, null, 2) + '\n', 'utf8')

const vocabulary = readJson('dist/vocab.json')
const cues = readJson('dist/cues.json')
const manifest = readJson('dist/manifest.json')
const qa = readJson('dist/qa-report.json')
const compact = {}

for (const [vocabKey, entry] of Object.entries(vocabulary)) {
  if (entry.reviewStatus !== 'approved') throw new Error(`Unapproved vocabulary entry: ${vocabKey}`)
  if (!entry.phonetic || !entry.partOfSpeech || !entry.definitionZh || !entry.definitionEn) throw new Error(`Incomplete vocabulary entry: ${vocabKey}`)
  compact[vocabKey] = {
    entryId:entry.entryId,
    lemma:entry.lemma,
    phonetic:entry.phonetic,
    partOfSpeech:entry.partOfSpeech,
    definitionZh:entry.definitionZh,
    definitionEn:entry.definitionEn,
    exampleCueId:entry.exampleCueId
  }
}

const clickable = cues.flatMap(cue => cue.tokens || []).filter(token => token.kind === 'word' && token.vocabKey)
for (const token of clickable) if (!compact[token.vocabKey]) throw new Error(`Token ${token.id} references missing vocabulary: ${token.vocabKey}`)
if (Object.keys(compact).length !== 358 || clickable.length !== 906) throw new Error(`Expected 358 entries and 906 clickable tokens, got ${Object.keys(compact).length} and ${clickable.length}`)

const body = [
  '// Generated from content/peter-rabbit/peter-rabbit-01/dist/vocab.json.',
  '// Run npm run content:peter:vocab:export instead of editing this file.',
  `module.exports = ${JSON.stringify(compact, null, 2)}`,
  ''
].join('\n')
fs.mkdirSync(path.dirname(outputPath), { recursive:true })
fs.writeFileSync(outputPath, body, 'utf8')

manifest.blockers = manifest.blockers.filter(item => !item.includes('approved vocabulary is not yet wired'))
manifest.clientIntegration = Object.assign({}, manifest.clientIntegration, { vocabularyWired:true, vocabularyEntries:Object.keys(compact).length, clickableTokens:clickable.length })
writeJson('dist/manifest.json', manifest)
qa.blockers = qa.blockers.filter(item => !item.includes('approved vocabulary is not yet wired'))
qa.checks.vocabularyClientWired = true
qa.clientIntegration = Object.assign({}, qa.clientIntegration, { vocabularyEntries:Object.keys(compact).length, clickableTokens:clickable.length })
writeJson('dist/qa-report.json', qa)

console.log(`Exported ${Object.keys(compact).length} reviewed entries for ${clickable.length} clickable tokens to ${outputPath}`)
