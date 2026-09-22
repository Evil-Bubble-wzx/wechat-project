const fs = require('node:fs')
const path = require('node:path')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const outputPath = path.resolve(process.argv[3] || 'miniprogram/modules/listen-read/cues-data.js')
const cues = JSON.parse(fs.readFileSync(path.join(packageDir, 'dist/cues.json'), 'utf8'))

const compactCues = cues.map(cue => ({
  id: cue.id,
  kind: cue.kind,
  startMs: cue.startMs,
  endMs: cue.endMs,
  text: cue.text,
  reviewStatus: cue.reviewStatus,
  tokens: (cue.tokens || []).map(token => ({
    id: token.id,
    surface: token.surface,
    kind: token.kind,
    vocabKey: token.vocabKey || null
  }))
}))

const body = [
  '// Generated from content/peter-rabbit/peter-rabbit-01/dist/cues.json.',
  '// Run the Peter Rabbit alignment/export pipeline instead of editing this file.',
  `module.exports = ${JSON.stringify({ 'peter-rabbit-01': compactCues }, null, 2)}`,
  ''
].join('\n')

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, body, 'utf8')
console.log(`Exported ${compactCues.length} cues to ${outputPath}`)
