const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { collectVocabularyFacts, normalizeWord, writeJson } = require('./vocab-review-workflow')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const britfonePath = process.argv[3] && path.resolve(process.argv[3])
const oewnDir = process.argv[4] && path.resolve(process.argv[4])
if (!britfonePath || !oewnDir || !fs.existsSync(britfonePath) || !fs.existsSync(oewnDir)) {
  console.error('Usage: node import-vocab-evidence.js <packageDir> <britfone.csv> <oewn-json-dir>')
  process.exit(1)
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function loadBritfone() {
  const byWord = new Map()
  for (const line of fs.readFileSync(britfonePath, 'utf8').split(/\r?\n/)) {
    const comma = line.indexOf(',')
    if (comma < 1) continue
    const rawWord = line.slice(0, comma).trim().replace(/\(\d+\)$/, '')
    const phonetic = line.slice(comma + 1).trim()
    if (!phonetic) continue
    const word = normalizeWord(rawWord)
    const values = byWord.get(word) || []
    const wrapped = `/${phonetic}/`
    if (!values.includes(wrapped)) values.push(wrapped)
    byWord.set(word, values)
  }
  return byWord
}

const irregular = {
  am: ['be'], are: ['be'], is: ['be'], was: ['be'], were: ['be'], been: ['be'],
  had: ['have'], has: ['have'], did: ['do'], done: ['do'], went: ['go'], gone: ['go'],
  came: ['come'], saw: ['see'], seen: ['see'], got: ['get'], gave: ['give'], given: ['give'],
  took: ['take'], taken: ['take'], made: ['make'], said: ['say'], told: ['tell'],
  thought: ['think'], caught: ['catch'], bought: ['buy'], brought: ['bring'],
  found: ['find'], lost: ['lose'], ran: ['run'], ate: ['eat'], eaten: ['eat'],
  lay: ['lie', 'lay'], shook: ['shake'], hung: ['hang'], left: ['leave'],
  feet: ['foot'], mice: ['mouse'], men: ['man'], children: ['child'],
  better: ['good', 'well'], best: ['good', 'well']
}

function lemmaCandidates(surface) {
  const candidates = [surface, ...(irregular[surface] || [])]
  if (surface.endsWith('ies') && surface.length > 4) candidates.push(`${surface.slice(0, -3)}y`)
  if (surface.endsWith('ied') && surface.length > 4) candidates.push(`${surface.slice(0, -3)}y`)
  if (surface.endsWith('ing') && surface.length > 5) {
    const stem = surface.slice(0, -3)
    candidates.push(stem, `${stem}e`)
    if (stem.at(-1) === stem.at(-2)) candidates.push(stem.slice(0, -1))
  }
  if (surface.endsWith('ed') && surface.length > 4) {
    const stem = surface.slice(0, -2)
    candidates.push(stem, `${stem}e`)
    if (stem.at(-1) === stem.at(-2)) candidates.push(stem.slice(0, -1))
  }
  if (surface.endsWith('es') && surface.length > 4) candidates.push(surface.slice(0, -2), surface.slice(0, -1))
  if (surface.endsWith('s') && !surface.endsWith('ss') && surface.length > 3) candidates.push(surface.slice(0, -1))
  return [...new Set(candidates)]
}

function loadEntriesFor(lemmas) {
  const letters = new Set(lemmas.map((lemma) => /^[a-z]/.test(lemma) ? lemma[0] : '0'))
  const entries = new Map()
  for (const letter of letters) {
    const filePath = path.join(oewnDir, `entries-${letter}.json`)
    if (!fs.existsSync(filePath)) continue
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    for (const [lemma, value] of Object.entries(document)) entries.set(normalizeWord(lemma), { lemma, value })
  }
  return entries
}

function loadSynsets() {
  const synsets = new Map()
  for (const name of fs.readdirSync(oewnDir)) {
    if (!/^(noun|verb|adj|adv)\..+\.json$/.test(name)) continue
    const document = JSON.parse(fs.readFileSync(path.join(oewnDir, name), 'utf8'))
    for (const [id, value] of Object.entries(document)) synsets.set(id, value)
  }
  return synsets
}

const posMap = { n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb' }
const facts = collectVocabularyFacts(packageDir)
const allLemmaCandidates = [...new Set(facts.groups.flatMap((group) => lemmaCandidates(group.normalized)))]
const entriesIndex = loadEntriesFor(allLemmaCandidates)
const synsets = loadSynsets()
const britfone = loadBritfone()
const output = {}

for (const group of facts.groups) {
  const options = []
  for (const candidate of lemmaCandidates(group.normalized)) {
    const entry = entriesIndex.get(candidate)
    if (!entry) continue
    for (const [rawPos, value] of Object.entries(entry.value)) {
      const partOfSpeech = posMap[rawPos]
      if (!partOfSpeech || !Array.isArray(value.sense)) continue
      const pronunciations = [
        ...(britfone.get(group.normalized) || []),
        ...(britfone.get(candidate) || []),
        ...((value.pronunciation || []).filter((item) => item.variety === 'GB').map((item) => `/${item.value}/`))
      ]
      for (const sense of value.sense.slice(0, 12)) {
        const synset = synsets.get(sense.synset) || {}
        options.push({
          ref: `oewn-2025:${sense.id}`,
          source: 'Open English WordNet 2025',
          lemma: normalizeWord(entry.lemma),
          partOfSpeech,
          senseId: sense.id,
          synsetId: sense.synset,
          gloss: Array.isArray(synset.definition) ? synset.definition[0] || null : null,
          examples: Array.isArray(synset.example) ? synset.example.slice(0, 3) : [],
          phonetic: [...new Set(pronunciations)][0] || null,
          pronunciationSource: pronunciations.length ? (britfone.has(group.normalized) || britfone.has(candidate) ? 'Britfone 3.0.1' : 'Open English WordNet 2025') : null
        })
      }
    }
  }
  if (!options.length && britfone.has(group.normalized)) {
    options.push({
      ref: `britfone-3.0.1:${group.normalized}`,
      source: 'Britfone 3.0.1',
      lemma: group.normalized,
      partOfSpeech: null,
      senseId: null,
      synsetId: null,
      gloss: null,
      examples: [],
      phonetic: britfone.get(group.normalized)[0],
      pronunciationSource: 'Britfone 3.0.1'
    })
  }
  output[group.normalized] = options.slice(0, 24)
}

writeJson(path.join(packageDir, 'source', 'lexicon', 'evidence.json'), {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  policy: {
    evidenceIsApproval: false,
    definitionsMustBeRewrittenAndHumanReviewed: true,
    wiktionaryContentCopied: false
  },
  sources: [
    {
      id: 'britfone-3.0.1',
      name: 'Britfone 3.0.1',
      license: 'MIT',
      repository: 'https://github.com/JoseLlarena/Britfone',
      commit: '1062be14adc96c358f2087ac5449d72130c7a6f4',
      file: 'britfone.main.3.0.1.csv',
      sha256: sha256(britfonePath),
      usage: 'British IPA candidates only'
    },
    {
      id: 'oewn-2025',
      name: 'Open English WordNet 2025',
      license: 'CC BY 4.0',
      sourceUrl: 'https://en-word.net/static/english-wordnet-2025-json.zip',
      releaseDate: '2025-12-31',
      archiveSha256: '7d749f6e2c39e6970e4997839dcf6e42fd281f3c2fae0171d2192bae8cfa4b51',
      usage: 'Lemma, part-of-speech and sense evidence; display definitions require project rewrite and human review'
    }
  ],
  entries: output
})

const matched = Object.values(output).filter((items) => items.length).length
console.log(JSON.stringify({ reviewUnits: facts.groups.length, evidenceMatchedUnits: matched, unmatchedUnits: facts.groups.length - matched }, null, 2))
