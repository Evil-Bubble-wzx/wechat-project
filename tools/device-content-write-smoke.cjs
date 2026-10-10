const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createGateway } = require('./device-api-gateway.cjs');
const words = require('../miniprogram/modules/sync/saved-word-sync');
const quiz = require('../miniprogram/modules/listen-read/peter-quiz-data');
const vocab = require('../miniprogram/modules/listen-read/peter-vocab-data');
const { accounts } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.cache/device-local/gateway.json')));
const server = createGateway(accounts);
function client(account, base) {
  const storage = new Map();
  const runtime = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    login: ({ success }) => success({ code: 'placeholder' }),
    request: options => {
      const controller = new AbortController();
      const url = base + new URL(options.url).pathname + new URL(options.url).search;
      fetch(url, { method: options.method, headers: options.header, body: options.data === undefined ? undefined : JSON.stringify(options.data), signal: controller.signal })
        .then(async response => options.success({ statusCode: response.status, header: Object.fromEntries(response.headers), data: await response.json() })).catch(options.fail);
      return { abort: () => controller.abort() };
    } };
  const { createBackendApi } = require(`../build/device-api-${account}/miniprogram/services/api.js`);
  return createBackendApi({ runtime, makeId: prefix => `${prefix}-${randomUUID()}`, maxRetries: 0 });
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = client('primary', base), second = client('primary', base), other = client('isolation', base);
  try {
    const user = await a.loginWechat();
    assert.equal((await second.loginWechat()).userId, user.userId);
    assert.notEqual((await other.loginWechat()).userId, user.userId);
    const before = (await a.getProgress('peter-rabbit-01')).progress;
    const previousEnd = Math.max(0, ...before.listenedRangesMs.map(range => range[1]));
    assert.ok(previousEnd + 2000 < 322026, 'Test fixture has no fresh audio range remaining');
    const mutation = { schemaVersion: 1, mutationId: `write-${randomUUID()}`, baseRevision: before.revision, contentVersion: 1, checkpointMs: previousEnd + 2000, listenedRangesMs: [[previousEnd, previousEnd + 2000]] };
    const written = await a.putProgress('peter-rabbit-01', mutation);
    assert.equal((await a.putProgress('peter-rabbit-01', mutation)).duplicate, true);
    assert.equal((await second.getProgress('peter-rabbit-01')).progress.revision, written.progress.revision);
    const batch = (operations, cursor = null) => { const value = { schemaVersion: 1, cursor, operations, limit: 100 }; return { ...value, batchId: words.batchIdFor(value) }; };
    const key = Object.keys(vocab)[0], entry = vocab[key];
    const pulled = await a.savedWordSync(batch([]));
    const existing = pulled.changes.find(word => word.entryId === entry.entryId);
    const operation = (action, revision) => {
      const value = { entryId: entry.entryId, pieceId: 'peter-rabbit-01', contentVersion: 1, vocabKey: key, surface: entry.lemma, lemma: entry.lemma, action, baseRevision: revision, occurredAt: new Date().toISOString() };
      return { ...value, operationId: words.operationIdFor(value) };
    };
    const savedBatch = batch([operation('save', existing?.revision || '0')]);
    const saved = await a.savedWordSync(savedBatch);
    assert.equal(saved.operations[0].word.state, 'saved');
    assert.equal((await a.savedWordSync(savedBatch)).operations[0].word.revision, saved.operations[0].word.revision);
    assert.ok((await second.savedWordSync(batch([], pulled.nextCursor))).changes.some(word => word.entryId === entry.entryId && word.state === 'saved'));
    const deleted = await a.savedWordSync(batch([operation('delete', saved.operations[0].word.revision)]));
    assert.equal(deleted.operations[0].word.state, 'deleted');
    const now = new Date().toISOString();
    const attempt = { schemaVersion: 1, attemptId: `quiz-${randomUUID()}`, workId: quiz.workId, pieceId: quiz.pieceId, contentVersion: quiz.contentVersion, quizVersion: quiz.quizVersion, questionIds: quiz.questions.map(q => q.id), selectedOptions: quiz.questions.map(q => q.answer), startedAt: now, submittedAt: now };
    const result = await a.submitQuiz(attempt);
    assert.equal(result.status, 'server_verified'); assert.equal(result.score, 100);
    const score = await a.learningScore();
    await a.submitQuiz(attempt);
    assert.equal((await a.learningScore()).totalPoints, score.totalPoints);
    assert.equal((await second.learningScore()).totalPoints, score.totalPoints);
    assert.equal((await other.getProgress('peter-rabbit-01')).progress.revision, '0');
    assert.equal((await other.savedWordSync(batch([]))).changes.length, 0);
    console.log('device-write.smoke.passed private-client=actual progress=replayed words=save-delete-replay quiz=10-real-questions score=dedup second-session=shared other-account=isolated');
  } finally { await Promise.allSettled([a.logout(), second.logout(), other.logout()]); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
