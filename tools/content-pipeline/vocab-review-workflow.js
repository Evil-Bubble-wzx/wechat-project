const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PARTS_OF_SPEECH = new Set([
  'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'determiner',
  'preposition', 'conjunction', 'auxiliary', 'interjection', 'numeral',
  'particle', 'other'
])

const FUNCTION_WORD_PARTS = new Map(Object.entries({
  a: 'determiner', an: 'determiner', the: 'determiner', this: 'determiner', that: 'determiner', these: 'determiner', those: 'determiner',
  and: 'conjunction', but: 'conjunction', or: 'conjunction', nor: 'conjunction', yet: 'conjunction',
  i: 'pronoun', me: 'pronoun', he: 'pronoun', him: 'pronoun', she: 'pronoun', it: 'pronoun', we: 'pronoun', us: 'pronoun', they: 'pronoun', them: 'pronoun', you: 'pronoun', who: 'pronoun', whom: 'pronoun', what: 'pronoun', which: 'pronoun',
  my: 'determiner', his: 'determiner', her: 'determiner', its: 'determiner', our: 'determiner', their: 'determiner', your: 'determiner',
  in: 'preposition', on: 'preposition', at: 'preposition', by: 'preposition', for: 'preposition', from: 'preposition', of: 'preposition', with: 'preposition', under: 'preposition', into: 'preposition', upon: 'preposition', through: 'preposition', behind: 'preposition', before: 'preposition', after: 'preposition', near: 'preposition', round: 'preposition', inside: 'preposition', outside: 'preposition', during: 'preposition', without: 'preposition', about: 'preposition',
  not: 'particle'
}))

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function normalizeWord(surface) {
  return String(surface).toLowerCase().replace(/[’']/g, "'")
}

function sourceKey(normalized) {
  return `${normalized}:pending:1`
}

function stableId(value) {
  return `ve-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

function cueDigest(cues) {
  const subtitleProjection = cues.map((cue) => ({
    id: cue.id,
    kind: cue.kind,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    tokens: cue.tokens.map((token) => ({
      id: token.id,
      surface: token.surface,
      kind: token.kind,
      startMs: token.startMs ?? null,
      endMs: token.endMs ?? null
    }))
  }))
  return crypto.createHash('sha256').update(JSON.stringify(subtitleProjection)).digest('hex')
}

function properNounSet(manifest) {
  return new Set((manifest.properNouns || []).map(normalizeWord))
}

function isProperNoun(token, names) {
  return token.properNoun === true || names.has(normalizeWord(token.surface))
}

function collectVocabularyFacts(packageDir) {
  const cues = readJson(path.join(packageDir, 'dist', 'cues.json'))
  const manifest = readJson(path.join(packageDir, 'source', 'manifest.source.json'))
  const names = properNounSet(manifest)
  const cueById = new Map(cues.map((cue) => [cue.id, cue]))
  const groups = new Map()
  let contentWordCount = 0
  let properNounCount = 0

  for (const cue of cues.filter((item) => item.kind === 'content')) {
    for (const token of cue.tokens.filter((item) => item.kind === 'word')) {
      contentWordCount += 1
      const normalized = normalizeWord(token.surface)
      if (isProperNoun(token, names)) {
        properNounCount += 1
        continue
      }
      const key = sourceKey(normalized)
      const group = groups.get(key) || {
        id: stableId(`${manifest.pieceId}:${key}`),
        sourceKey: key,
        normalized,
        surfaces: new Set(),
        occurrences: []
      }
      group.surfaces.add(token.surface)
      group.occurrences.push({
        cueId: cue.id,
        tokenId: token.id,
        surface: token.surface,
        cueText: cue.text,
        startMs: Number.isInteger(token.startMs) ? token.startMs : cue.startMs,
        endMs: Number.isInteger(token.endMs) ? token.endMs : cue.endMs
      })
      groups.set(key, group)
    }
  }

  return {
    cues,
    manifest,
    cueById,
    contentWordCount,
    properNounCount,
    clickableTokenCount: [...groups.values()].reduce((sum, group) => sum + group.occurrences.length, 0),
    groups: [...groups.values()].sort((left, right) => left.normalized.localeCompare(right.normalized))
  }
}

function loadEvidence(packageDir) {
  const evidencePath = path.join(packageDir, 'source', 'lexicon', 'evidence.json')
  if (!fs.existsSync(evidencePath)) return { schemaVersion: 1, entries: {} }
  return readJson(evidencePath)
}

function chooseLemmaEvidence(group, evidence) {
  const options = evidence.entries[group.normalized] || []
  const exact = options.filter((item) => item.lemma === group.normalized)
  const lemmas = new Set(options.map((item) => item.lemma))
  const partEvidence = lemmas.size === 1 ? options : exact
  const parts = new Set(partEvidence.map((item) => item.partOfSpeech).filter(Boolean))
  return {
    options,
    lemma: lemmas.size === 1 ? [...lemmas][0] : group.normalized,
    partOfSpeech: FUNCTION_WORD_PARTS.get(group.normalized) || (parts.size === 1 ? [...parts][0] : null)
  }
}

function createVocabularyCandidates(packageDir) {
  const facts = collectVocabularyFacts(packageDir)
  const evidence = loadEvidence(packageDir)
  const entries = facts.groups.map((group, index) => {
    const selected = chooseLemmaEvidence(group, evidence)
    const directPronunciation = selected.options.find((item) => item.phonetic && item.lemma === group.normalized)
      || selected.options.find((item) => item.phonetic)
    const risks = []
    if (!selected.options.length) risks.push('no_open_source_match')
    if (new Set(selected.options.map((item) => item.lemma)).size > 1) risks.push('lemma_ambiguous')
    if (new Set(selected.options.map((item) => item.partOfSpeech).filter(Boolean)).size > 1) risks.push('part_of_speech_ambiguous')
    if (!directPronunciation) risks.push('phonetic_missing')
    if (FUNCTION_WORD_PARTS.has(group.normalized)) risks.push('function_word_context_required')
    if (group.normalized.includes('-')) risks.push('hyphenated_or_special_form')
    if (group.normalized === 'scr-r-ritch') risks.push('onomatopoeia')
    return {
      reviewId: `V${String(index + 1).padStart(3, '0')}`,
      id: group.id,
      sourceKey: group.sourceKey,
      normalized: group.normalized,
      surfaces: [...group.surfaces].sort(),
      occurrences: group.occurrences,
      machineCandidate: {
        lemma: selected.lemma,
        partOfSpeech: selected.partOfSpeech,
        senseNo: 1,
        phonetic: directPronunciation ? directPronunciation.phonetic : null,
        definitionEn: null,
        definitionZh: null
      },
      evidence: selected.options,
      riskFlags: risks,
      action: null,
      exclusionReason: null,
      senses: [{
        entryId: null,
        lemma: selected.lemma,
        partOfSpeech: selected.partOfSpeech,
        senseNo: 1,
        phonetic: directPronunciation ? directPronunciation.phonetic : null,
        definitionEn: null,
        definitionZh: null,
        occurrenceTokenIds: group.occurrences.map((item) => item.tokenId),
        evidenceRefs: selected.options.slice(0, 8).map((item) => item.ref)
      }],
      confirmed: false,
      note: null
    }
  })

  return {
    schemaVersion: 1,
    pieceId: facts.manifest.pieceId,
    status: 'machine_draft',
    generatedAt: new Date().toISOString(),
    sourceCueSha256: cueDigest(facts.cues),
    policy: {
      machineSuggestionsAreApproval: false,
      finalKeyFormat: 'lemma:partOfSpeech:senseNo',
      britishIpaPreferred: true,
      allReviewUnitsRequireConfirmation: true,
      properNounsExcluded: true
    },
    sourceSummary: evidence.sources || [],
    counts: {
      cues: facts.cues.length,
      contentWords: facts.contentWordCount,
      properNouns: facts.properNounCount,
      clickableTokens: facts.clickableTokenCount,
      reviewUnits: entries.length,
      evidenceMatchedUnits: entries.filter((item) => item.evidence.length).length,
      highRiskUnits: entries.filter((item) => item.riskFlags.length).length
    },
    entries,
    signoff: {
      reviewer: null,
      reviewedAt: null
    }
  }
}

function createVocabularyReviewDraft(candidates) {
  return structuredClone({ ...candidates, status: 'draft' })
}

function normalizeLemma(value) {
  return normalizeWord(String(value || '').trim()).replace(/\s+/g, '_')
}

function finalEntryKey(sense) {
  return `${normalizeLemma(sense.lemma)}:${sense.partOfSpeech}:${sense.senseNo}`
}

function validateVocabularyReview(document, packageDir) {
  const errors = []
  const expected = createVocabularyCandidates(packageDir)
  const entries = Array.isArray(document.entries) ? document.entries : []
  if (document.schemaVersion !== 1) errors.push('schemaVersion must be 1.')
  if (document.pieceId !== expected.pieceId) errors.push(`pieceId must be ${expected.pieceId}.`)
  if (document.sourceCueSha256 !== expected.sourceCueSha256) errors.push('sourceCueSha256 does not match the reviewed subtitles.')
  if (entries.length !== expected.entries.length) errors.push(`Exactly ${expected.entries.length} review units are required.`)
  const expectedById = new Map(expected.entries.map((item) => [item.id, item]))
  const seenIds = new Set()
  const finalKeys = new Map()

  for (const entry of entries) {
    if (seenIds.has(entry.id)) errors.push(`${entry.id}: duplicate review-unit id.`)
    seenIds.add(entry.id)
    const source = expectedById.get(entry.id)
    if (!source) {
      errors.push(`${entry.id}: unknown review-unit id.`)
      continue
    }
    if (entry.sourceKey !== source.sourceKey || entry.normalized !== source.normalized) {
      errors.push(`${entry.reviewId}: source identity was changed.`)
    }
    if (entry.confirmed !== true) errors.push(`${entry.reviewId}: explicit human confirmation is required.`)
    if (!['approve', 'excludeProperNoun'].includes(entry.action)) errors.push(`${entry.reviewId}: action must be approve or excludeProperNoun.`)
    if (entry.action === 'excludeProperNoun') {
      if (!String(entry.exclusionReason || '').trim()) errors.push(`${entry.reviewId}: exclusionReason is required.`)
      continue
    }
    if (!Array.isArray(entry.senses) || !entry.senses.length) {
      errors.push(`${entry.reviewId}: at least one approved sense is required.`)
      continue
    }
    const expectedTokens = new Set(source.occurrences.map((item) => item.tokenId))
    const assignedTokens = []
    for (const sense of entry.senses) {
      if (!normalizeLemma(sense.lemma)) errors.push(`${entry.reviewId}: lemma is required.`)
      if (!PARTS_OF_SPEECH.has(sense.partOfSpeech)) errors.push(`${entry.reviewId}: invalid partOfSpeech.`)
      if (!Number.isInteger(sense.senseNo) || sense.senseNo < 1) errors.push(`${entry.reviewId}: senseNo must be a positive integer.`)
      if (!/^\/.+\/$/.test(String(sense.phonetic || '').trim())) errors.push(`${entry.reviewId}: phonetic must be IPA wrapped in slashes.`)
      if (!String(sense.definitionEn || '').trim()) errors.push(`${entry.reviewId}: definitionEn is required.`)
      if (!String(sense.definitionZh || '').trim()) errors.push(`${entry.reviewId}: definitionZh is required.`)
      const key = finalEntryKey(sense)
      const fingerprint = JSON.stringify({
        phonetic: String(sense.phonetic || '').trim(),
        definitionEn: String(sense.definitionEn || '').trim(),
        definitionZh: String(sense.definitionZh || '').trim()
      })
      if (finalKeys.has(key) && finalKeys.get(key) !== fingerprint) {
        errors.push(`${entry.reviewId}: shared final key ${key} must use identical approved IPA and definitions.`)
      }
      finalKeys.set(key, fingerprint)
      for (const tokenId of sense.occurrenceTokenIds || []) assignedTokens.push(tokenId)
    }
    const assignedSet = new Set(assignedTokens)
    if (assignedSet.size !== assignedTokens.length) errors.push(`${entry.reviewId}: an occurrence is assigned to more than one sense.`)
    if (assignedSet.size !== expectedTokens.size || [...expectedTokens].some((id) => !assignedSet.has(id))) {
      errors.push(`${entry.reviewId}: every occurrence must be assigned to exactly one sense.`)
    }
  }

  for (const expectedEntry of expected.entries) {
    if (!seenIds.has(expectedEntry.id)) errors.push(`${expectedEntry.reviewId}: review unit is missing.`)
  }
  const signoff = document.signoff || {}
  if (!String(signoff.reviewer || '').trim()) errors.push('signoff.reviewer is required.')
  if (!signoff.reviewedAt || Number.isNaN(Date.parse(signoff.reviewedAt))) errors.push('signoff.reviewedAt must be a valid timestamp.')
  if (document.status !== 'completed') errors.push('status must be completed.')
  return { valid: errors.length === 0, errors, expectedCount: expected.entries.length }
}

function bindPendingVocabulary(packageDir, candidates) {
  const facts = collectVocabularyFacts(packageDir)
  const names = properNounSet(facts.manifest)
  const candidateKeys = new Set(candidates.entries.map((entry) => entry.sourceKey))
  const cues = structuredClone(facts.cues)
  for (const cue of cues.filter((item) => item.kind === 'content')) {
    for (const token of cue.tokens.filter((item) => item.kind === 'word')) {
      const normalized = normalizeWord(token.surface)
      if (isProperNoun(token, names)) {
        token.properNoun = true
        token.vocabKey = null
      } else {
        const key = sourceKey(normalized)
        if (!candidateKeys.has(key)) throw new Error(`${token.id}: no vocabulary review unit for ${key}.`)
        token.properNoun = false
        token.vocabKey = key
        token.reviewStatus = 'needs_enrichment'
      }
    }
  }
  writeJson(path.join(packageDir, 'dist', 'cues.json'), cues)
  return cues
}

function applyVocabularyReview(document, packageDir) {
  const validation = validateVocabularyReview(document, packageDir)
  if (!validation.valid) {
    const error = new Error(`Vocabulary review validation failed:\n- ${validation.errors.join('\n- ')}`)
    error.validation = validation
    throw error
  }
  const cues = readJson(path.join(packageDir, 'dist', 'cues.json'))
  const tokenById = new Map()
  for (const cue of cues) for (const token of cue.tokens) tokenById.set(token.id, token)
  const vocabulary = {}
  const corrections = []

  for (const entry of document.entries) {
    if (entry.action === 'excludeProperNoun') {
      for (const occurrence of entry.occurrences) {
        const token = tokenById.get(occurrence.tokenId)
        if (!token) throw new Error(`${entry.reviewId}: missing token ${occurrence.tokenId}.`)
        token.properNoun = true
        token.vocabKey = null
        token.reviewStatus = 'approved_exclusion'
      }
      corrections.push({ reviewId: entry.reviewId, action: entry.action, reason: entry.exclusionReason })
      continue
    }
    for (const sense of entry.senses) {
      const key = finalEntryKey(sense)
      const occurrenceSet = new Set(sense.occurrenceTokenIds)
      const occurrences = entry.occurrences.filter((item) => occurrenceSet.has(item.tokenId))
      const existing = vocabulary[key]
      const nextOccurrences = occurrences.map(({ cueId, tokenId }) => ({ cueId, tokenId }))
      if (existing) {
        existing.surfaceForms = [...new Set([...existing.surfaceForms, ...occurrences.map((item) => item.surface)])]
        existing.occurrences.push(...nextOccurrences)
        existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...(sense.evidenceRefs || [])])]
      } else {
        vocabulary[key] = {
          entryId: sense.entryId || stableId(`${document.pieceId}:${key}`),
          lemma: normalizeLemma(sense.lemma),
          surfaceForms: [...new Set(occurrences.map((item) => item.surface))],
          phonetic: sense.phonetic.trim(),
          partOfSpeech: sense.partOfSpeech,
          senseNo: sense.senseNo,
          definitionZh: sense.definitionZh.trim(),
          definitionEn: sense.definitionEn.trim(),
          exampleCueId: occurrences[0].cueId,
          occurrences: nextOccurrences,
          evidenceRefs: sense.evidenceRefs || [],
          reviewStatus: 'approved',
          reviewedBy: document.signoff.reviewer.trim(),
          reviewedAt: document.signoff.reviewedAt
        }
      }
      for (const occurrence of occurrences) {
        const token = tokenById.get(occurrence.tokenId)
        if (!token) throw new Error(`${entry.reviewId}: missing token ${occurrence.tokenId}.`)
        token.vocabKey = key
        token.properNoun = false
        token.reviewStatus = 'approved'
      }
    }
    corrections.push({
      reviewId: entry.reviewId,
      action: entry.action,
      sourceKey: entry.sourceKey,
      finalKeys: entry.senses.map(finalEntryKey),
      note: entry.note || null
    })
  }

  const qaPath = path.join(packageDir, 'dist', 'qa-report.json')
  const manifestPath = path.join(packageDir, 'dist', 'manifest.json')
  const qa = readJson(qaPath)
  const manifest = readJson(manifestPath)
  qa.generatedAt = new Date().toISOString()
  qa.checks.vocabularyApproved = true
  qa.checks.humanReviewComplete = false
  qa.publishable = false
  qa.counts.clickableTokens = Object.values(vocabulary).reduce((sum, item) => sum + item.occurrences.length, 0)
  qa.counts.vocabEntries = Object.keys(vocabulary).length
  qa.vocabularyReview = {
    status: 'approved', reviewedBy: document.signoff.reviewer.trim(), reviewedAt: document.signoff.reviewedAt,
    reviewUnitCount: document.entries.length, finalEntryCount: Object.keys(vocabulary).length
  }
  qa.blockers = qa.blockers.filter((item) => !/vocab/i.test(item) && !/词汇|词条/.test(item))
  manifest.counts = { ...manifest.counts, ...qa.counts }
  manifest.vocabularyReview = qa.vocabularyReview
  manifest.publishable = false
  manifest.status = 'needs_review'
  manifest.artifacts.vocab = 'dist/vocab.json'
  manifest.blockers = [...qa.blockers]
  const correctionDocument = {
    schemaVersion: 1,
    pieceId: document.pieceId,
    status: 'vocabulary_approved',
    corrections,
    reviewedBy: document.signoff.reviewer.trim(),
    reviewedAt: document.signoff.reviewedAt,
    notes: ['Vocabulary editorial review is complete.', 'Rights and remaining content gates are still pending.', 'This record does not make the package publishable.']
  }
  writeJson(path.join(packageDir, 'review', 'vocab-corrections.json'), correctionDocument)
  writeJson(path.join(packageDir, 'dist', 'cues.json'), cues)
  writeJson(path.join(packageDir, 'dist', 'vocab.json'), vocabulary)
  writeJson(qaPath, qa)
  writeJson(manifestPath, manifest)
  return { cues, vocabulary, qa, manifest, corrections: correctionDocument }
}

module.exports = {
  PARTS_OF_SPEECH,
  normalizeWord,
  finalEntryKey,
  cueDigest,
  collectVocabularyFacts,
  createVocabularyCandidates,
  createVocabularyReviewDraft,
  validateVocabularyReview,
  bindPendingVocabulary,
  applyVocabularyReview,
  readJson,
  writeJson
}
