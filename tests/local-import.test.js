const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const quizPackage = require('../miniprogram/modules/listen-read/peter-quiz-data')
const { prepareLocalImport, createImportSession, canonicalStringify, sha256, normalizeRangesMs } = require('../miniprogram/modules/sync/local-import')

function progress(overrides = {}) {
  return Object.assign({
    seconds: 40,
    checkpointSeconds: 21.2346,
    completed: true,
    duration: 322.026,
    listenedRanges: [[10.0004, 20], [-1, 4], [3.97, 10.02], [321, 400]],
    listenedSeconds: 999,
    coverage: 1,
    completionReason: 'coverage_and_ended',
    contentVersion: 1,
    audioKey: '1|private-or-local-resource-path',
    schemaVersion: 2,
    updatedAt: '2026-09-24T01:02:03.000Z'
  }, overrides)
}

function attempt(overrides = {}) {
  const questions = quizPackage.questions
  return Object.assign({
    attemptId: 'local-peter-rabbit-01-1',
    schemaVersion: 1,
    workId: 'peter-rabbit',
    pieceId: 'peter-rabbit-01',
    contentVersion: 1,
    quizVersion: 1,
    questionIds: questions.map(question => question.id),
    selectedOptions: questions.map(() => 0),
    startedAt: '2026-09-24T01:00:00.000Z',
    submittedAt: '2026-09-24T01:05:00.000Z',
    status: 'local_unverified',
    score: 100,
    mastery: true,
    title: 'Must not leave the device'
  }, overrides)
}

function state(overrides = {}) {
  return Object.assign({
    progress: { 'peter-rabbit-01': progress() },
    words: ['Once', 'upon', 'Once', '  time  '],
    results: [attempt()],
    favorites: ['peter-rabbit'],
    recent: ['peter-rabbit'],
    listeningSec: 99999,
    listenDaily: { '2026-09-24:peter-rabbit-01': 99999 },
    idMigrationVersion: 1,
    progressSchemaVersion: 2
  }, overrides)
}

test('portable SHA-256 matches Node crypto for ASCII and Unicode', () => {
  for (const value of ['', 'abc', '听阅 · Peter Rabbit']) {
    assert.equal(sha256(value), crypto.createHash('sha256').update(value).digest('hex'))
  }
})

test('canonical JSON ignores object key order', () => {
  assert.equal(canonicalStringify({ b: 2, a: { d: 4, c: 3 } }), canonicalStringify({ a: { c: 3, d: 4 }, b: 2 }))
})

test('S-01 prepares only progress, words and unverified Quiz facts', () => {
  const plan = prepareLocalImport(state())
  assert.equal(plan.ready, true)
  assert.match(plan.snapshotId, /^s01-v1:[a-f0-9]{64}$/)
  assert.deepEqual(plan.summary, { progressPieces: 1, words: 3, quizAttempts: 1, excluded: 0 })
  assert.equal(plan.limitations.words, 'surface_only')
  assert.deepEqual(Object.keys(plan.payload).sort(), ['progress','quizAttempts','schemaVersion','words'])
  const exportedProgress = plan.payload.progress[0]
  assert.deepEqual(exportedProgress.listenedRangesMs, [[0,20000],[321000,322026]])
  assert.equal(exportedProgress.checkpointMs, 21235)
  for (const forbidden of ['completed','coverage','listenedSeconds','completionReason','audioKey']) assert.equal(exportedProgress[forbidden], undefined)
  const exportedAttempt = plan.payload.quizAttempts[0]
  for (const forbidden of ['status','score','mastery','title']) assert.equal(exportedAttempt[forbidden], undefined)
  for (const forbidden of ['favorites','recent','listeningSec','listenDaily']) assert.equal(plan.payload[forbidden], undefined)
})

test('range normalization clamps, rounds, sorts and merges adjacent evidence', () => {
  assert.deepEqual(normalizeRangesMs([[5,6],[1,2.0004],[2.05,3],[-4,.5],[7,7],[9,20]],10000), {
    valid: true,
    value: [[0,500],[1000,3000],[5000,6000],[9000,10000]]
  })
  assert.equal(normalizeRangesMs([[0,'bad']],1000).valid, false)
})

test('equivalent learning state produces the same deterministic snapshotId', () => {
  const first = prepareLocalImport(state())
  const second = prepareLocalImport(state({
    results: [attempt()],
    words: ['time','upon','Once'],
    progress: { 'peter-rabbit-01': progress({ listenedRanges: [[321,400],[3.97,20],[-1,4]] }) }
  }))
  assert.equal(second.ready, true)
  assert.equal(first.snapshotId, second.snapshotId)
})

test('preparing a snapshot never mutates the supplied local state', () => {
  const input = state()
  const before = JSON.stringify(input)
  prepareLocalImport(input)
  assert.equal(JSON.stringify(input), before)
})

test('Demo and entitlement fields block the whole snapshot', () => {
  for (const field of ['user','loans','demoCoupons','demoPurchases','coupons','purchased']) {
    const plan = prepareLocalImport(state({ [field]: [] }))
    assert.equal(plan.ready, false)
    assert.equal(plan.snapshotId, null)
    assert.ok(plan.errors.some(error => error.startsWith('demo_fields_present:')))
  }
})

test('unknown and incompatible records are excluded with reasons', () => {
  const plan = prepareLocalImport(state({
    progress: {
      unknown: progress(),
      'peter-rabbit-01': progress({ schemaVersion: 1 })
    },
    words: ['not-in-the-reviewed-vocabulary'],
    results: [attempt({ schemaVersion: 0 })]
  }))
  assert.equal(plan.ready, false)
  assert.ok(plan.errors.includes('no_importable_learning_data'))
  assert.deepEqual(new Set(plan.excluded.map(item => item.reason)), new Set(['unknown_piece','unsupported_schema','not_in_current_vocabulary']))
})

test('word candidates preserve reviewed surface and reject inferred case variants', () => {
  const plan = prepareLocalImport(state({ progress: {}, results: [], words: ['Once','once','Once',' '] }))
  assert.equal(plan.ready, true)
  assert.deepEqual(plan.payload.words, [{ surface: 'Once' }])
  assert.equal(plan.summary.excluded, 2)
})

test('identical Quiz attempt IDs deduplicate while conflicting payloads block', () => {
  const duplicate = prepareLocalImport(state({ results: [attempt(), attempt()] }))
  assert.equal(duplicate.ready, true)
  assert.equal(duplicate.payload.quizAttempts.length, 1)
  const conflict = prepareLocalImport(state({ results: [attempt(), attempt({ selectedOptions: quizPackage.questions.map(() => 1) })] }))
  assert.equal(conflict.ready, false)
  assert.ok(conflict.errors.includes('quiz_attempt_conflict:local-peter-rabbit-01-1'))
})

test('server-verified, rejected, legacy and malformed Quiz records are not reimported', () => {
  const plan = prepareLocalImport(state({ progress: {}, words: ['Once'], results: [
    attempt({ attemptId: 'server', status: 'server_verified' }),
    attempt({ attemptId: 'rejected', status: 'rejected' }),
    attempt({ attemptId: 'legacy', schemaVersion: 0 }),
    attempt({ attemptId: 'bad-time', startedAt: 'later', submittedAt: 'earlier' })
  ] }))
  assert.equal(plan.ready, true)
  assert.equal(plan.payload.quizAttempts.length, 0)
  assert.equal(plan.summary.excluded, 4)
})

test('a non-object source is blocked as an invalid production state', () => {
  for (const input of [null, [], 'state']) {
    const plan = prepareLocalImport(input)
    assert.equal(plan.ready, false)
    assert.deepEqual(plan.errors, ['invalid_production_state'])
  }
})

test('import session requires explicit consent', async () => {
  const session = createImportSession(prepareLocalImport(state()))
  assert.equal(session.status(), 'awaiting_consent')
  await assert.rejects(session.submit(async () => ({})), /consent/i)
  assert.equal(session.consent(), 'consented')
  assert.equal(session.decline(), 'awaiting_consent')
})

test('concurrent submit is single-flight and manual retry keeps the snapshotId', async () => {
  const plan = prepareLocalImport(state())
  const session = createImportSession(plan)
  session.consent()
  const requests = []
  let resolveFirst
  const submitter = request => { requests.push(request); return new Promise(resolve => { resolveFirst = resolve }) }
  const first = session.submit(submitter)
  const concurrent = session.submit(submitter)
  assert.equal(first, concurrent)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 1)
  resolveFirst({ mock: true })
  await first
  const retry = session.submit(async request => { requests.push(request); return { mock: true } })
  await retry
  assert.equal(requests.length, 2)
  assert.equal(requests[0].snapshotId, plan.snapshotId)
  assert.equal(requests[1].snapshotId, plan.snapshotId)
  assert.deepEqual(requests[0], requests[1])
})

test('mock success does not add an acknowledged or imported state', async () => {
  const plan = prepareLocalImport(state())
  const session = createImportSession(plan)
  session.consent()
  await session.submit(async () => ({ status: 200, acknowledged: true }))
  assert.equal(session.status(), 'consented')
  assert.equal(session.preview().status, undefined)
  assert.equal(plan.status, 'prepared')
  assert.equal(plan.imported, undefined)
})

test('a blocked plan cannot be consented to', () => {
  const session = createImportSession(prepareLocalImport({}))
  assert.throws(() => session.consent(), /not ready/i)
})
