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
