const fs = require('node:fs')
const path = require('node:path')

const TOKEN_ACTIONS = new Set(['keepCanonical', 'replaceSurface', 'adjustTiming'])
const OMITTED_CUE_ACTIONS = new Set(['restoreCue', 'omitCue'])

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function tokenParts(text) {
  return text.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\s+|[^A-Za-z\s]+/g) || []
}

function normalizeWord(surface) {
  return surface.toLowerCase().replace(/[’']/g, "'")
}

function formatReviewId(index) {
  return `R${String(index + 1).padStart(2, '0')}`
}

function calculateListenCoverage(listenedSeconds, durationMs) {
  const totalSeconds = Math.ceil(durationMs / 1000)
  if (!totalSeconds) return 0
  const validSeconds = new Set((listenedSeconds || []).filter((second) => (
    Number.isInteger(second) && second >= 0 && second < totalSeconds
  )))
  const rawCoverage = Math.min(1, validSeconds.size / totalSeconds)
  return rawCoverage >= 0.995 ? 1 : rawCoverage
}

function loadReviewFacts(packageDir) {
  const sourceManifest = readJson(path.join(packageDir, 'source', 'manifest.source.json'))
  const unmatched = readJson(path.join(packageDir, 'work', 'unmatched.json'))
  const canonicalCues = readJson(path.join(packageDir, 'work', 'cues.draft.json'))
  const alignedCues = readJson(path.join(packageDir, 'work', 'cues.aligned.json'))
  const durationMs = sourceManifest.audioMetadata.durationMs
  const omittedSpecs = [
    { id: 'O1', cueId: 'c0012', listenStartMs: 74700, listenEndMs: 80640, anchorRatio: 0.0667 },
    { id: 'O2', cueId: 'c0028', listenStartMs: 164080, listenEndMs: 167460, anchorRatio: 0.1667 }
  ]

  const tokenDecisions = unmatched.items
    .filter((item) => item.matchKind !== 'inferred')
    .map((item, index) => {
      const cue = canonicalCues.find((candidate) => candidate.id === item.cueId)
      return {
        id: formatReviewId(index),
        type: 'token',
        cueId: item.cueId,
        tokenId: item.tokenId,
        cueText: cue.text,
        canonical: item.canonical,
        recognized: item.recognized,
        matchKind: item.matchKind,
        confidence: item.confidence,
        listenStartMs: Math.max(0, item.startMs - 2000),
        listenEndMs: Math.min(durationMs, item.endMs + 2000),
        originalStartMs: item.startMs,
        originalEndMs: item.endMs,
        recommendation: 'keepCanonical',
        action: null,
        replacementText: null,
        startMs: null,
        endMs: null,
        note: null,
        confirmed: false
      }
    })

  const omittedDecisions = omittedSpecs.map((spec) => {
    const cue = canonicalCues.find((candidate) => candidate.id === spec.cueId)
    return {
      ...spec,
      type: 'omittedCue',
      canonicalText: cue.text,
      recommendation: 'omitCue',
      action: null,
      actualText: null,
      startMs: null,
      endMs: null,
      reason: null,
      confirmed: false
    }
  })

  return { sourceManifest, unmatched, canonicalCues, alignedCues, tokenDecisions, omittedDecisions }
}

function createReviewDraft(packageDir) {
  const { sourceManifest, tokenDecisions, omittedDecisions } = loadReviewFacts(packageDir)
  return {
    schemaVersion: 1,
    pieceId: sourceManifest.pieceId,
    status: 'draft',
    generatedAt: new Date().toISOString(),
    audio: {
      path: '../source/audio-original.mp3',
      durationMs: sourceManifest.audioMetadata.durationMs,
      sha256: sourceManifest.audioMetadata.sha256
    },
    policy: {
      subtitleAuthority: 'recording',
      machineSuggestionsAreApproval: false,
      fullListenRequired: true,
      vocabularyInScope: false,
      rightsInScope: false
    },
    decisions: [...tokenDecisions, ...omittedDecisions],
    signoff: {
      reviewer: null,
      fullListenCompleted: false,
      fullListenCoverage: 0,
      fullListenCompletedAt: null,
      reviewedAt: null
    }
  }
}

function createReviewTranscript(packageDir) {
  const { alignedCues, tokenDecisions, omittedDecisions } = loadReviewFacts(packageDir)
  const issueIdsByCue = new Map()
  for (const decision of tokenDecisions) {
    const ids = issueIdsByCue.get(decision.cueId) || []
    ids.push(decision.id)
    issueIdsByCue.set(decision.cueId, ids)
  }

  const transcript = alignedCues.map((cue) => ({
    id: cue.id,
    cueId: cue.id,
    kind: cue.kind,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    issueIds: issueIdsByCue.get(cue.id) || [],
    omittedCandidate: false
  }))

  for (const decision of omittedDecisions) {
    transcript.push({
      id: decision.id,
      cueId: decision.cueId,
      kind: 'review_marker',
      startMs: decision.listenStartMs,
      endMs: decision.listenEndMs,
      text: decision.canonicalText,
      issueIds: [decision.id],
      omittedCandidate: true
    })
  }

  return transcript.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
}

function validateReviewDocument(document, packageDir) {
  const errors = []
  const facts = loadReviewFacts(packageDir)
  const expected = [...facts.tokenDecisions, ...facts.omittedDecisions]
  const decisions = Array.isArray(document.decisions) ? document.decisions : []

  if (document.schemaVersion !== 1) errors.push('schemaVersion must be 1.')
  if (document.pieceId !== facts.sourceManifest.pieceId) errors.push(`pieceId must be ${facts.sourceManifest.pieceId}.`)
  if (decisions.length !== expected.length) errors.push(`Exactly ${expected.length} decisions are required.`)

  const byId = new Map(decisions.map((decision) => [decision.id, decision]))
  if (byId.size !== decisions.length) errors.push('Decision ids must be unique.')

  for (const expectedDecision of expected) {
    const decision = byId.get(expectedDecision.id)
    if (!decision) {
      errors.push(`${expectedDecision.id} is missing.`)
      continue
    }
    if (decision.type !== expectedDecision.type) errors.push(`${decision.id}: type was changed.`)
    if (decision.cueId !== expectedDecision.cueId) errors.push(`${decision.id}: cueId was changed.`)
    if (expectedDecision.type === 'token' && decision.tokenId !== expectedDecision.tokenId) {
      errors.push(`${decision.id}: tokenId was changed.`)
    }
    if (decision.confirmed !== true) errors.push(`${decision.id}: explicit human confirmation is required.`)

    if (decision.type === 'token') {
      if (!TOKEN_ACTIONS.has(decision.action)) errors.push(`${decision.id}: invalid token action.`)
      if (expectedDecision.matchKind === 'exact' && decision.action === 'replaceSurface') {
        errors.push(`${decision.id}: exact matches may keep canonical text or adjust timing, but may not replace the surface.`)
      }
      if (decision.action === 'replaceSurface' && !String(decision.replacementText || '').trim()) {
        errors.push(`${decision.id}: replacementText is required for replaceSurface.`)
      }
      if (decision.action === 'adjustTiming') {
        if (!Number.isInteger(decision.startMs) || !Number.isInteger(decision.endMs) || decision.endMs <= decision.startMs) {
          errors.push(`${decision.id}: valid integer startMs/endMs are required for adjustTiming.`)
        }
      }
    } else {
      if (!OMITTED_CUE_ACTIONS.has(decision.action)) errors.push(`${decision.id}: invalid omitted-cue action.`)
      if (decision.action === 'omitCue' && !String(decision.reason || '').trim()) {
        errors.push(`${decision.id}: reason is required for omitCue.`)
      }
      if (decision.action === 'restoreCue') {
        if (!String(decision.actualText || '').trim()) errors.push(`${decision.id}: actualText is required for restoreCue.`)
        if (!Number.isInteger(decision.startMs) || !Number.isInteger(decision.endMs) || decision.endMs <= decision.startMs) {
          errors.push(`${decision.id}: valid integer startMs/endMs are required for restoreCue.`)
        }
      }
    }
  }

  const signoff = document.signoff || {}
  if (!String(signoff.reviewer || '').trim()) errors.push('signoff.reviewer is required.')
  if (signoff.fullListenCompleted !== true) errors.push('signoff.fullListenCompleted must be true.')
  if (!Number.isFinite(signoff.fullListenCoverage) || signoff.fullListenCoverage < 0.95) {
    errors.push('signoff.fullListenCoverage must be at least 0.95.')
  }
  if (!signoff.fullListenCompletedAt || Number.isNaN(Date.parse(signoff.fullListenCompletedAt))) {
    errors.push('signoff.fullListenCompletedAt must be a valid timestamp.')
  }
  if (!signoff.reviewedAt || Number.isNaN(Date.parse(signoff.reviewedAt))) {
    errors.push('signoff.reviewedAt must be a valid timestamp.')
  }

  return { valid: errors.length === 0, errors, expectedCount: expected.length }
}

function makeTokens(cueId, text, startMs, endMs) {
  const parts = tokenParts(text)
  const wordIndexes = parts.map((surface, index) => (/^[A-Za-z]/.test(surface) ? index : -1)).filter((index) => index >= 0)
  const duration = endMs - startMs
  let wordPosition = 0
  return parts.map((surface, index) => {
    const token = { id: `${cueId}:t${String(index).padStart(2, '0')}`, surface }
    if (/^\s+$/.test(surface)) return { ...token, kind: 'space' }
    if (!/^[A-Za-z]/.test(surface)) return { ...token, kind: 'punctuation' }
    const tokenStart = Math.round(startMs + duration * wordPosition / wordIndexes.length)
    const tokenEnd = Math.round(startMs + duration * (wordPosition + 1) / wordIndexes.length)
    wordPosition += 1
    return {
      ...token,
      normalized: normalizeWord(surface),
      kind: 'word',
      properNoun: false,
      vocabKey: null,
      reviewStatus: 'needs_enrichment',
      startMs: tokenStart,
      endMs: tokenEnd,
      alignment: 'human_reviewed',
      alignmentConfidence: 1
    }
  })
}

function createCorrections(document) {
  const tokenDecisions = document.decisions.filter((decision) => decision.type === 'token')
  const cueDecisions = document.decisions.filter((decision) => decision.type === 'omittedCue')
  return {
    schemaVersion: 1,
    pieceId: document.pieceId,
    status: 'subtitle_approved',
    cueCorrections: cueDecisions.map(({ id, cueId, action, actualText, startMs, endMs, reason, note }) => ({
      reviewId: id, cueId, action, actualText: actualText || null, startMs: startMs ?? null, endMs: endMs ?? null,
      reason: reason || null, note: note || null
    })),
    tokenCorrections: tokenDecisions.map(({ id, cueId, tokenId, action, replacementText, startMs, endMs, note }) => ({
      reviewId: id, cueId, tokenId, action, replacementText: replacementText || null,
      startMs: startMs ?? null, endMs: endMs ?? null, note: note || null
    })),
    vocabCorrections: [],
    subtitleReview: {
      complete: true,
      decisionCount: document.decisions.length,
      fullListenCompleted: true,
      fullListenCoverage: document.signoff.fullListenCoverage
    },
    reviewedBy: document.signoff.reviewer.trim(),
    reviewedAt: document.signoff.reviewedAt,
    notes: [
      'Subtitle/audio review is complete; vocabulary editorial review remains pending.',
      'Rights and release-jurisdiction approval remain pending.',
      'This record does not make the package publishable.'
    ]
  }
}

function applyCorrections(document, packageDir) {
  const validation = validateReviewDocument(document, packageDir)
  if (!validation.valid) {
    const error = new Error(`Review validation failed:\n- ${validation.errors.join('\n- ')}`)
    error.validation = validation
    throw error
  }

  const { alignedCues } = loadReviewFacts(packageDir)
  const corrections = createCorrections(document)
  const cues = structuredClone(alignedCues)
  const cueById = new Map(cues.map((cue) => [cue.id, cue]))

  for (const correction of corrections.tokenCorrections) {
    const cue = cueById.get(correction.cueId)
    const token = cue && cue.tokens.find((candidate) => candidate.id === correction.tokenId)
    if (!token) throw new Error(`${correction.reviewId}: target token no longer exists.`)
    token.subtitleReviewStatus = 'approved'
    token.subtitleReviewId = correction.reviewId
    if (correction.action === 'replaceSurface') {
      token.canonicalSurface = token.surface
      token.surface = correction.replacementText
      token.normalized = normalizeWord(correction.replacementText)
      token.vocabKey = null
      cue.text = cue.tokens.map((candidate) => candidate.surface).join('')
    }
    if (correction.action === 'adjustTiming') {
      token.startMs = correction.startMs
      token.endMs = correction.endMs
    }
  }

  for (const correction of corrections.cueCorrections) {
    if (correction.action !== 'restoreCue') continue
    if (cueById.has(correction.cueId)) throw new Error(`${correction.reviewId}: cue already exists.`)
    const cue = {
      id: correction.cueId,
      kind: 'content',
      startMs: correction.startMs,
      endMs: correction.endMs,
      text: correction.actualText,
      translation: null,
      reviewStatus: 'needs_review',
      subtitleReviewStatus: 'approved',
      subtitleReviewId: correction.reviewId,
      tokens: makeTokens(correction.cueId, correction.actualText, correction.startMs, correction.endMs)
    }
    cues.push(cue)
    cueById.set(cue.id, cue)
  }

  for (const cue of cues) cue.subtitleReviewStatus = 'approved'
  cues.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]
    if (!(Number.isInteger(cue.startMs) && Number.isInteger(cue.endMs) && cue.endMs > cue.startMs)) {
      throw new Error(`${cue.id}: invalid cue timing after corrections.`)
    }
    if (index > 0 && cue.startMs < cues[index - 1].startMs) throw new Error(`${cue.id}: cue order is not monotonic.`)
    if (cue.tokens.length && cue.tokens.map((token) => token.surface).join('') !== cue.text) {
      throw new Error(`${cue.id}: token round-trip failed.`)
    }
  }

  const qaPath = path.join(packageDir, 'dist', 'qa-report.json')
  const manifestPath = path.join(packageDir, 'dist', 'manifest.json')
  const qa = readJson(qaPath)
  const manifest = readJson(manifestPath)
  qa.generatedAt = new Date().toISOString()
  qa.publishable = false
  qa.status = 'needs_review'
  qa.checks.subtitleReviewComplete = true
  qa.checks.humanReviewComplete = false
  qa.subtitleReview = {
    status: 'approved',
    reviewedBy: corrections.reviewedBy,
    reviewedAt: corrections.reviewedAt,
    decisionCount: corrections.subtitleReview.decisionCount,
    fullListenCoverage: corrections.subtitleReview.fullListenCoverage
  }
  qa.counts.cues = cues.length
  qa.blockers = [
    'Vocabulary review units require POS, sense, phonetics and definitions.',
    'Vocabulary editorial review is pending.',
    'Rights need release-jurisdiction review.'
  ]
  manifest.publishable = false
  manifest.status = 'needs_review'
  manifest.counts.cues = cues.length
  manifest.subtitleReview = qa.subtitleReview
  manifest.blockers = [...qa.blockers]

  writeJson(path.join(packageDir, 'review', 'corrections.json'), corrections)
  writeJson(path.join(packageDir, 'dist', 'cues.json'), cues)
  writeJson(qaPath, qa)
  writeJson(manifestPath, manifest)
  return { corrections, cues, qa, manifest }
}

module.exports = {
  TOKEN_ACTIONS,
  OMITTED_CUE_ACTIONS,
  calculateListenCoverage,
  createReviewDraft,
  createReviewTranscript,
  validateReviewDocument,
  createCorrections,
  applyCorrections,
  readJson,
  writeJson
}
