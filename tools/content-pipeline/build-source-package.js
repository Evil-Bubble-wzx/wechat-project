const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01');
const sourceDir = path.join(packageDir, 'source');
const workDir = path.join(packageDir, 'work');
const distDir = path.join(packageDir, 'dist');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function cleanSourceText(rawText, extraction) {
  const normalized = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const startIndex = normalized.indexOf(extraction.start);
  if (startIndex < 0) throw new Error(`Text start marker not found: ${extraction.start}`);
  const endIndex = normalized.indexOf(extraction.end, startIndex);
  if (endIndex < 0) throw new Error(`Text end marker not found: ${extraction.end}`);

  const removalSet = new Set(extraction.removeStandaloneLines || []);
  const story = normalized.slice(startIndex, endIndex);
  const paragraphs = story
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !removalSet.has(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);

  for (let index = 0; index < paragraphs.length - 1; index += 1) {
    if (paragraphs[index].endsWith('--')) {
      paragraphs[index] = `${paragraphs[index]} ${paragraphs[index + 1]}`;
      paragraphs.splice(index + 1, 1);
      index -= 1;
    }
  }

  return `${paragraphs.join('\n\n')}\n`;
}

function tokenParts(text) {
  return text.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\s+|[^A-Za-z\s]+/g) || [];
}

function normalizeWord(surface) {
  return surface.toLowerCase().replace(/[’']/g, "'");
}

function sentencesFromText(text) {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const sentences = [];
  for (const paragraph of text.trim().split(/\n\s*\n/)) {
    const protectedParagraph = paragraph.replace(/\b(Mr|Mrs|Ms|Dr)\./g, '$1\uF000');
    for (const part of segmenter.segment(protectedParagraph)) {
      const sentence = part.segment.replace(/\uF000/g, '.').trim();
      if (sentence) sentences.push(sentence);
    }
  }
  return sentences;
}

function makeToken(cueId, index, surface, properNouns) {
  const id = `${cueId}:t${String(index).padStart(2, '0')}`;
  if (/^\s+$/.test(surface)) return { id, surface, kind: 'space' };
  if (!/^[A-Za-z]/.test(surface)) return { id, surface, kind: 'punctuation' };

  const normalized = normalizeWord(surface);
  const properNoun = properNouns.has(normalized);
  return {
    id,
    surface,
    normalized,
    kind: 'word',
    properNoun,
    vocabKey: properNoun ? null : `${normalized}:pending:1`,
    reviewStatus: 'needs_enrichment'
  };
}

fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

const manifestPath = path.join(sourceDir, 'manifest.source.json');
const manifest = readJson(manifestPath);
const rawTextPath = path.join(packageDir, manifest.rawText);
const canonicalTextPath = path.join(packageDir, manifest.text);
const audioPath = path.join(packageDir, manifest.audio);

if (!fs.existsSync(rawTextPath)) throw new Error(`Missing raw text: ${rawTextPath}`);
if (!fs.existsSync(audioPath)) throw new Error(`Missing audio: ${audioPath}`);

const canonicalText = cleanSourceText(fs.readFileSync(rawTextPath, 'utf8'), manifest.textExtraction);
if (!fs.existsSync(canonicalTextPath)) {
  fs.writeFileSync(canonicalTextPath, canonicalText, 'utf8');
} else if (fs.readFileSync(canonicalTextPath, 'utf8') !== canonicalText) {
  throw new Error('source/text-original.txt already exists and differs from the newly extracted text; source files are never overwritten automatically.');
}

fs.writeFileSync(path.join(workDir, 'canonical-text.txt'), canonicalText, 'utf8');

const properNouns = new Set((manifest.properNouns || []).map(normalizeWord));
const sentences = sentencesFromText(canonicalText);
const vocabulary = {};
let tokenCount = 0;
let wordCount = 0;
let clickableTokenCount = 0;

const cues = sentences.map((text, cueIndex) => {
  const cueId = `c${String(cueIndex + 1).padStart(4, '0')}`;
  const tokens = tokenParts(text).map((surface, tokenIndex) => makeToken(cueId, tokenIndex, surface, properNouns));
  tokenCount += tokens.length;

  for (const token of tokens) {
    if (token.kind !== 'word') continue;
    wordCount += 1;
    if (!token.vocabKey) continue;
    clickableTokenCount += 1;
    const entry = vocabulary[token.vocabKey] || {
      lemma: token.normalized,
      phonetic: null,
      partOfSpeech: null,
      definitionZh: null,
      definitionEn: null,
      exampleCueId: cueId,
      properNoun: false,
      image: null,
      occurrences: 0,
      reviewStatus: 'needs_enrichment'
    };
    entry.occurrences += 1;
    vocabulary[token.vocabKey] = entry;
  }

  return {
    id: cueId,
    kind: 'content',
    startMs: null,
    endMs: null,
    text,
    translation: null,
    reviewStatus: 'needs_alignment',
    tokens
  };
});

writeJson(path.join(workDir, 'cues.draft.json'), cues);
writeJson(path.join(workDir, 'vocab.draft.json'), vocabulary);
writeJson(path.join(workDir, 'audio-probe.json'), {
  schemaVersion: 1,
  pieceId: manifest.pieceId,
  path: manifest.audio,
  mimeType: manifest.audioMetadata.mimeType,
  bytes: fs.statSync(audioPath).size,
  durationMs: manifest.audioMetadata.durationMs,
  sha256: sha256(audioPath),
  source: 'browser_metadata_and_file_hash',
  reviewStatus: 'verified'
});
writeJson(path.join(workDir, 'alignment.json'), {
  schemaVersion: 1,
  pieceId: manifest.pieceId,
  status: 'not_run',
  canonicalCueCount: cues.length,
  alignedCueCount: 0,
  coverage: 0,
  reason: 'No ASR word timestamps or forced-alignment output has been generated yet.'
});
writeJson(path.join(workDir, 'unmatched.json'), {
  schemaVersion: 1,
  pieceId: manifest.pieceId,
  status: 'not_run',
  unmatchedCanonicalWords: [],
  unmatchedAsrWords: [],
  note: 'Populated by the alignment stage; an empty list here does not mean that alignment passed.'
});

const hashMatches = sha256(audioPath) === manifest.audioMetadata.sha256;
const blockers = [
  'Missing LibriVox intro/outro transcript and timing.',
  'All content cues are missing startMs/endMs.',
  'Vocabulary entries require POS, sense, phonetics and definitions.',
  'Human subtitle and vocabulary review is pending.',
  'Rights need release-jurisdiction review.'
];

const qaReport = {
  schemaVersion: 1,
  pieceId: manifest.pieceId,
  generatedAt: new Date().toISOString(),
  status: 'needs_review',
  publishable: false,
  checks: {
    sourceManifestPresent: true,
    sourceAudioPresent: true,
    sourceTextPresent: true,
    audioSha256MatchesManifest: hashMatches,
    canonicalTextExtracted: true,
    tokenRoundTrip: cues.every((cue) => cue.tokens.map((token) => token.surface).join('') === cue.text),
    cueTimingComplete: false,
    introOutroSeparated: false,
    vocabularyApproved: false,
    humanReviewComplete: false,
    rightsReleaseApproved: false
  },
  counts: {
    cues: cues.length,
    words: wordCount,
    tokens: tokenCount,
    clickableTokens: clickableTokenCount,
    vocabEntries: Object.keys(vocabulary).length
  },
  blockers
};
writeJson(path.join(distDir, 'qa-report.json'), qaReport);
writeJson(path.join(distDir, 'manifest.json'), {
  schemaVersion: 1,
  pieceId: manifest.pieceId,
  contentVersion: 0,
  status: 'needs_review',
  publishable: false,
  language: manifest.language,
  audio: {
    source: manifest.audio,
    durationMs: manifest.audioMetadata.durationMs,
    sha256: manifest.audioMetadata.sha256
  },
  artifacts: {
    cuesDraft: 'work/cues.draft.json',
    vocabDraft: 'work/vocab.draft.json',
    qaReport: 'dist/qa-report.json'
  },
  counts: qaReport.counts,
  blockers
});

console.log(JSON.stringify({ packageDir, pieceId: manifest.pieceId, counts: qaReport.counts, publishable: false }, null, 2));
