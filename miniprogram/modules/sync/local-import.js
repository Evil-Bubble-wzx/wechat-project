const catalog = require('../catalog/catalog-data')
const cuesByPiece = require('../listen-read/cues-data')
const quizPackage = require('../listen-read/peter-quiz-data')

const SNAPSHOT_SCHEMA_VERSION = 1
const PROGRESS_SCHEMA_VERSION = 2
const WORK_ID = 'peter-rabbit'
const PIECE_ID = 'peter-rabbit-01'
const currentBook = catalog.find(book => book.workId === WORK_ID && book.pieceId === PIECE_ID)
const CONTENT_VERSION = currentBook && currentBook.contentVersion
const QUIZ_VERSION = quizPackage.quizVersion
const DEMO_FIELDS = ['user','loans','demoCoupons','demoInvitationCompleted','demoPurchases','coupons','purchased','invitationCompleted']
const allowedWordSurfaces = new Set((cuesByPiece[PIECE_ID] || []).flatMap(cue => cue.tokens || []).filter(token => token.vocabKey).map(token => token.surface))
const quizQuestions = new Map((quizPackage.questions || []).map(question => [question.id, question]))

function prepareLocalImport(state) {
  const errors = []
  const excluded = []
  if (!isPlainObject(state)) {
    return blockedPlan(['invalid_production_state'], excluded)
  }
  const demoFields = DEMO_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(state, field))
  if (demoFields.length) errors.push('demo_fields_present:' + demoFields.sort(compareText).join(','))

  const progress = prepareProgress(state.progress, excluded)
  const words = prepareWords(state.words, excluded)
  const quizResult = prepareQuizAttempts(state.results, excluded)
  errors.push(...quizResult.errors)

  const payload = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    progress,
    words,
    quizAttempts: quizResult.attempts
  }
  const itemCount = progress.length + words.length + quizResult.attempts.length
  if (!itemCount) errors.push('no_importable_learning_data')
  const ready = errors.length === 0
  const snapshotId = ready ? 's01-v1:' + sha256(canonicalStringify(payload)) : null

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    status: 'prepared',
    ready,
    snapshotId,
    payload,
    summary: {
      progressPieces: progress.length,
      words: words.length,
      quizAttempts: quizResult.attempts.length,
      excluded: excluded.length
    },
    limitations: { words: 'surface_only' },
    excluded,
    errors
  }
}

function prepareProgress(input, excluded) {
  if (input == null) return []
  if (!isPlainObject(input)) {
    excluded.push(exclusion('progress', null, 'invalid_collection'))
    return []
  }
  const output = []
  for (const pieceId of Object.keys(input).sort(compareText)) {
    const entry = input[pieceId]
    const reason = progressInvalidReason(pieceId, entry)
    if (reason) {
      excluded.push(exclusion('progress', pieceId, reason))
      continue
    }
    const durationMs = Math.round(Number(entry.duration) * 1000)
    const ranges = normalizeRangesMs(entry.listenedRanges, durationMs)
    if (!ranges.valid) {
      excluded.push(exclusion('progress', pieceId, 'invalid_listened_ranges'))
      continue
    }
    const checkpointMs = clamp(Math.round(Number(entry.checkpointSeconds) * 1000), 0, durationMs)
    if (!ranges.value.length && checkpointMs === 0) {
      excluded.push(exclusion('progress', pieceId, 'no_trusted_evidence'))
      continue
    }
    output.push({
      pieceId,
      contentVersion: CONTENT_VERSION,
      durationMs,
      checkpointMs,
      listenedRangesMs: ranges.value,
      updatedAt: new Date(entry.updatedAt).toISOString()
    })
  }
  return output
}

function progressInvalidReason(pieceId, entry) {
  if (pieceId !== PIECE_ID) return 'unknown_piece'
  if (!isPlainObject(entry)) return 'invalid_record'
  if (entry.schemaVersion !== PROGRESS_SCHEMA_VERSION) return 'unsupported_schema'
  if (entry.contentVersion !== CONTENT_VERSION) return 'content_version_mismatch'
  const duration = Number(entry.duration)
  if (!Number.isFinite(duration) || duration <= 0 || !currentBook || Math.abs(duration - Number(currentBook.duration)) > 0.5) return 'duration_mismatch'
  if (!Number.isFinite(Number(entry.checkpointSeconds))) return 'invalid_checkpoint'
  if (!validDate(entry.updatedAt)) return 'invalid_updated_at'
  if (!Array.isArray(entry.listenedRanges)) return 'invalid_listened_ranges'
  return null
}

function normalizeRangesMs(input, durationMs) {
  const ranges = []
  for (const range of input) {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(value => Number.isFinite(Number(value)))) return { valid: false, value: [] }
    const start = clamp(Math.round(Number(range[0]) * 1000), 0, durationMs)
    const end = clamp(Math.round(Number(range[1]) * 1000), 0, durationMs)
    if (end > start) ranges.push([start, end])
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range[0] <= previous[1] + 50) previous[1] = Math.max(previous[1], range[1])
    else merged.push(range.slice())
  }
  return { valid: true, value: merged }
}

function prepareWords(input, excluded) {
  if (input == null) return []
  if (!Array.isArray(input)) {
    excluded.push(exclusion('words', null, 'invalid_collection'))
    return []
  }
  const seen = new Set()
  const output = []
  input.forEach((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      excluded.push(exclusion('word', String(index), 'empty_or_invalid_surface'))
      return
    }
    const surface = value.trim()
    if (!allowedWordSurfaces.has(surface)) {
      excluded.push(exclusion('word', surface, 'not_in_current_vocabulary'))
      return
    }
    if (!seen.has(surface)) {
      seen.add(surface)
      output.push({ surface })
    }
  })
  return output.sort((a, b) => compareText(a.surface, b.surface))
}

function prepareQuizAttempts(input, excluded) {
  if (input == null) return { attempts: [], errors: [] }
  if (!Array.isArray(input)) {
    excluded.push(exclusion('quiz', null, 'invalid_collection'))
    return { attempts: [], errors: [] }
  }
  const attempts = new Map()
  const conflicts = new Set()
  input.forEach((entry, index) => {
    const result = sanitizeQuizAttempt(entry)
    if (!result.valid) {
      excluded.push(exclusion('quiz', entry && entry.attemptId || String(index), result.reason))
      return
    }
    const serialized = canonicalStringify(result.value)
    const previous = attempts.get(result.value.attemptId)
    if (previous && previous.serialized !== serialized) conflicts.add(result.value.attemptId)
    else if (!previous) attempts.set(result.value.attemptId, { serialized, value: result.value })
  })
  return {
    attempts: [...attempts.values()].map(entry => entry.value).sort((a, b) => compareText(a.attemptId, b.attemptId)),
    errors: [...conflicts].sort(compareText).map(id => 'quiz_attempt_conflict:' + id)
  }
}

function sanitizeQuizAttempt(entry) {
  if (!isPlainObject(entry)) return invalid('invalid_record')
  if (entry.schemaVersion !== 1) return invalid('unsupported_schema')
  if (entry.status !== 'local_unverified') return invalid('not_local_unverified')
  if (entry.workId !== WORK_ID || entry.pieceId !== PIECE_ID) return invalid('identity_mismatch')
  if (entry.contentVersion !== CONTENT_VERSION || entry.quizVersion !== QUIZ_VERSION) return invalid('version_mismatch')
  const attemptId = stringValue(entry.attemptId)
  if (!attemptId) return invalid('missing_attempt_id')
  if (!validDate(entry.startedAt) || !validDate(entry.submittedAt) || Date.parse(entry.startedAt) > Date.parse(entry.submittedAt)) return invalid('invalid_timestamps')
  if (!Array.isArray(entry.questionIds) || !Array.isArray(entry.selectedOptions) || entry.questionIds.length !== quizQuestions.size || entry.selectedOptions.length !== entry.questionIds.length) return invalid('invalid_answers')
  const seen = new Set()
  for (let index = 0; index < entry.questionIds.length; index += 1) {
    const questionId = entry.questionIds[index]
    const question = quizQuestions.get(questionId)
    const selection = entry.selectedOptions[index]
    if (!question || seen.has(questionId) || !Number.isInteger(selection) || selection < 0 || selection >= question.options.length) return invalid('invalid_answers')
    seen.add(questionId)
  }
  return {
    valid: true,
    value: {
      attemptId,
      workId: WORK_ID,
      pieceId: PIECE_ID,
      contentVersion: CONTENT_VERSION,
      quizVersion: QUIZ_VERSION,
      questionIds: entry.questionIds.slice(),
      selectedOptions: entry.selectedOptions.slice(),
      startedAt: new Date(entry.startedAt).toISOString(),
      submittedAt: new Date(entry.submittedAt).toISOString()
    }
  }
}

function createImportSession(plan) {
  if (!plan || plan.status !== 'prepared') throw new Error('A prepared import plan is required')
  let consented = false
  let inFlight = null
  return {
    preview() { return { ready: plan.ready, snapshotId: plan.snapshotId, summary: Object.assign({}, plan.summary), limitations: Object.assign({}, plan.limitations), errors: plan.errors.slice(), excluded: plan.excluded.map(item => Object.assign({}, item)) } },
    consent() { if (!plan.ready) throw new Error('Import plan is not ready'); consented = true; return this.status() },
    decline() { consented = false; return this.status() },
    status() { return consented ? 'consented' : 'awaiting_consent' },
    submit(submitter) {
      if (!consented) return Promise.reject(new Error('Import consent is required'))
      if (typeof submitter !== 'function') return Promise.reject(new Error('Import submitter is required'))
      if (!inFlight) {
        const request = { snapshotId: plan.snapshotId, payload: clone(plan.payload), limitations: Object.assign({}, plan.limitations) }
        inFlight = Promise.resolve().then(() => submitter(request)).finally(() => { inFlight = null })
      }
      return inFlight
    }
  }
}

function blockedPlan(errors, excluded) {
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, status: 'prepared', ready: false, snapshotId: null, payload: { schemaVersion: SNAPSHOT_SCHEMA_VERSION, progress: [], words: [], quizAttempts: [] }, summary: { progressPieces: 0, words: 0, quizAttempts: 0, excluded: excluded.length }, limitations: { words: 'surface_only' }, excluded, errors }
}

function canonicalStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']'
  if (isPlainObject(value)) return '{' + Object.keys(value).sort(compareText).map(key => JSON.stringify(key) + ':' + canonicalStringify(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

// Synchronous UTF-8 SHA-256 for the WeChat runtime; no Node crypto dependency.
function sha256(text) {
  const bytes = utf8Bytes(String(text))
  const bitLength = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const high = Math.floor(bitLength / 0x100000000)
  const low = bitLength >>> 0
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 255)
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 255)
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(64)
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + index * 4
      words[index] = ((bytes[cursor] << 24) | (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3]) >>> 0
    }
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15], b = words[index - 2]
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10)
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0
    }
    let [a,b,c,d,e,f,g,h] = hash
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + choose + constants[index] + words[index]) >>> 0
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + majority) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    hash[0]=(hash[0]+a)>>>0;hash[1]=(hash[1]+b)>>>0;hash[2]=(hash[2]+c)>>>0;hash[3]=(hash[3]+d)>>>0
    hash[4]=(hash[4]+e)>>>0;hash[5]=(hash[5]+f)>>>0;hash[6]=(hash[6]+g)>>>0;hash[7]=(hash[7]+h)>>>0
  }
  return hash.map(value => value.toString(16).padStart(8, '0')).join('')
}

function utf8Bytes(text) {
  const bytes = []
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00); index += 1 }
    }
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 63))
    else if (code < 0x10000) bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63))
    else bytes.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 63), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63))
  }
  return bytes
}

const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits))
const clamp = (value, min, max) => Math.max(min, Math.min(value, max))
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)
const validDate = value => Number.isFinite(Date.parse(value))
const stringValue = value => typeof value === 'string' ? value.trim() : ''
const exclusion = (kind, id, reason) => ({ kind, id, reason })
const invalid = reason => ({ valid: false, reason })
const clone = value => JSON.parse(JSON.stringify(value))

module.exports = { SNAPSHOT_SCHEMA_VERSION, prepareLocalImport, createImportSession, canonicalStringify, sha256, normalizeRangesMs }
