const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const packageDir = path.resolve(__dirname, '..', 'content', 'peter-rabbit', 'peter-rabbit-01');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(packageDir, relativePath), 'utf8'));
}

test('Peter Rabbit source package has stable, verified inputs', () => {
  const source = readJson('source/manifest.source.json');
  const audioPath = path.join(packageDir, source.audio);
  const textPath = path.join(packageDir, source.text);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex');

  assert.equal(source.pieceId, 'peter-rabbit-01');
  assert.ok(fs.statSync(audioPath).size > 2_000_000);
  assert.ok(fs.readFileSync(textPath, 'utf8').startsWith('Once upon a time'));
  assert.equal(hash, source.audioMetadata.sha256);
});

test('Peter Rabbit C-03 evidence pack is complete but release remains gated', () => {
  const rights = readJson('source/rights.json');
  const evidence = readJson('source/rights-evidence.json');
  const provenance = readJson('source/editorial-provenance.json');
  const qa = readJson('dist/qa-report.json');
  const coverPath = path.resolve(packageDir, '..', '..', '..', 'miniprogram', 'assets', 'peter.png');
  const coverHash = crypto.createHash('sha256').update(fs.readFileSync(coverPath)).digest('hex');

  assert.equal(rights.targetRegion, 'Mainland China');
  assert.equal(rights.reviewStatus, 'READY_FOR_EXTERNAL_REVIEW');
  assert.equal(rights.releaseApproved, false);
  assert.equal(evidence.reviewStatus, 'READY_FOR_EXTERNAL_REVIEW');
  assert.equal(evidence.operatingEntity, 'PENDING_ENTITY');
  assert.equal(evidence.requiredExternalSignoff.status, 'PENDING');
  assert.equal(evidence.assets.find(item => item.evidenceId === 'PR-INTERIOR-ILLUSTRATION-01').status, 'N/A');
  assert.equal(coverHash, provenance.scope.cover.exportSha256);
  assert.equal(qa.checks.rightsReleaseApproved, false);
  assert.equal(qa.publishable, false);
});

test('Peter Rabbit C-04 candidate has verified metadata, Quiz evidence and versioned hashes', () => {
  const metadata = readJson('dist/metadata.json');
  const quiz = readJson('dist/quiz.json');
  const review = readJson('review/c04-review.json');
  const cues = readJson('dist/cues.json');
  const manifest = readJson('dist/manifest.json');
  const qa = readJson('dist/qa-report.json');
  const cueMap = new Map(cues.map(cue => [cue.id, cue]));
  const hash = relativePath => crypto.createHash('sha256').update(fs.readFileSync(path.join(packageDir, relativePath))).digest('hex');

  assert.equal(metadata.workId, 'peter-rabbit');
  assert.equal(metadata.pieceId, 'peter-rabbit-01');
  assert.equal(metadata.contentVersion, 1);
  assert.equal(metadata.level, null);
  assert.equal(metadata.pageCount, null);
  assert.equal(metadata.wordCount.value, 952);
  assert.equal(metadata.durationMs, 322026);
  assert.equal(metadata.review.status, 'approved_ai_assisted');
  assert.equal(metadata.review.humanReviewComplete, false);

  assert.equal(quiz.questions.length, 10);
  assert.equal(quiz.mode, 'fixed_order');
  assert.equal(quiz.masteryFeedbackPercent, 80);
  assert.equal(quiz.blocksContent, false);
  assert.equal(quiz.audioOptionsIncluded, false);
  for (const question of quiz.questions) {
    const evidence = question.sourceCueIds.map(id => cueMap.get(id)?.text || '').join(' ');
    assert.ok(question.sourceCueIds.every(id => cueMap.get(id)?.kind === 'content'), question.id);
    assert.ok(question.evidenceQuoteFragments.every(fragment => evidence.includes(fragment)), question.id);
  }

  assert.equal(review.status, 'DONE_AI_ASSISTED');
  assert.equal(review.humanReviewComplete, false);
  assert.equal(manifest.contentVersion, 1);
  assert.equal(manifest.assetHashes.metadata, hash('dist/metadata.json'));
  assert.equal(manifest.assetHashes.quiz, hash('dist/quiz.json'));
  assert.equal(manifest.assetHashes.cues, hash('dist/cues.json'));
  assert.equal(manifest.assetHashes.vocabulary, hash('dist/vocab.json'));
  assert.equal(qa.checks.metadataApproved, true);
  assert.equal(qa.checks.quizApproved, true);
  assert.equal(qa.checks.humanReviewComplete, false);
  assert.equal(qa.publishable, false);
});

test('Peter Rabbit canonical cue draft round-trips text', () => {
  const cues = readJson('work/cues.draft.json');
  const ids = new Set();

  assert.ok(cues.length > 50);
  for (const cue of cues) {
    assert.ok(!ids.has(cue.id));
    ids.add(cue.id);
    assert.equal(cue.tokens.map((token) => token.surface).join(''), cue.text);
    assert.equal(cue.startMs, null);
    assert.equal(cue.endMs, null);
    assert.equal(cue.reviewStatus, 'needs_alignment');
  }
});

test('Peter Rabbit reviewed cues are complete while non-subtitle gates remain blocked', () => {
  const cues = readJson('dist/cues.json');
  const publishManifest = readJson('dist/manifest.json');
  const qa = readJson('dist/qa-report.json');
  const ids = new Set();

  assert.equal(cues.length, 59);
  for (const [index, cue] of cues.entries()) {
    assert.ok(!ids.has(cue.id));
    ids.add(cue.id);
    assert.ok(Number.isInteger(cue.startMs));
    assert.ok(Number.isInteger(cue.endMs));
    assert.ok(cue.endMs > cue.startMs);
    if (index > 0) assert.ok(cue.startMs >= cues[index - 1].startMs);
    if (cue.tokens.length) assert.equal(cue.tokens.map((token) => token.surface).join(''), cue.text);
  }

  assert.equal(publishManifest.status, 'needs_review');
  assert.equal(publishManifest.publishable, false);
  assert.equal(qa.checks.tokenRoundTrip, true);
  assert.equal(qa.checks.cueTimingComplete, true);
  assert.equal(qa.checks.introOutroSeparated, true);
  assert.equal(qa.checks.subtitleReviewComplete, true);
  assert.equal(qa.checks.humanReviewComplete, false);
  assert.equal(qa.alignment.timingMonotonic, true);
  assert.deepEqual(
    cues.filter((cue) => cue.id === 'c0012').map(({ startMs, endMs }) => [startMs, endMs]),
    [[75000, 80600]]
  );
  assert.deepEqual(
    cues.filter((cue) => cue.id === 'c0028').map(({ startMs, endMs }) => [startMs, endMs]),
    [[164080, 167460]]
  );
  assert.ok(qa.blockers.length > 0);
});
