// Internal fixture only. Source release gates are preserved, never approved here.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const repo = path.resolve(__dirname, '../..');
const source = path.join(repo, 'content/peter-rabbit/peter-rabbit-01');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  if (process.env.APP_ENV !== 'local' || url.hostname !== '127.0.0.1' || url.port !== '55433' || url.pathname !== '/tingyue') throw new Error('Only the dedicated device-local database is allowed');
  if (process.env.OBJECT_STORAGE_ENDPOINT !== '127.0.0.1' || process.env.OBJECT_STORAGE_PORT !== '59000') throw new Error('Only device-local object storage is allowed');
  const manifestBytes = fs.readFileSync(path.join(source, 'dist/manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const quizBytes = fs.readFileSync(path.join(source, 'dist/quiz.json'));
  const quiz = JSON.parse(quizBytes);
  const clientQuiz = require(path.join(repo, 'miniprogram/modules/listen-read/peter-quiz-data.js'));
  if (quiz.questions.length !== 10 || JSON.stringify(quiz.questions) !== JSON.stringify(clientQuiz.questions)) throw new Error('Client/server quiz mismatch');
  const assets = [
    ['audio', 'source/audio-original.mp3', 'audio/mpeg'], ['subtitles', 'dist/cues.json', 'application/json'],
    ['text', 'work/canonical-text.txt', 'text/plain'], ['vocabulary', 'dist/vocab.json', 'application/json'],
    ['quiz', 'dist/quiz.json', 'application/json'], ['metadata', 'dist/metadata.json', 'application/json'],
  ].map(([type, file, mime]) => ({ type, file, mime, bytes: fs.readFileSync(path.join(source, file)) }));
  if (hash(assets[0].bytes) !== manifest.audio.sha256) throw new Error('Audio hash mismatch');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const s3 = new S3Client({ endpoint: 'http://127.0.0.1:59000', region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT manifest_sha256 FROM content_versions WHERE piece_id='peter-rabbit-01' AND content_version=1");
    if (existing.rows.length && existing.rows[0].manifest_sha256.trim() !== hash(manifestBytes)) throw new Error('Existing fixture has different content; refusing overwrite');
    if (existing.rows.length) { await client.query('ROLLBACK'); console.log('Matching internal content fixture already present'); return; }
    await client.query("INSERT INTO works(id,title,status,access_type) VALUES ('peter-rabbit','The Tale of Peter Rabbit','published','free')");
    await client.query("INSERT INTO pieces(id,work_id,title,status,access_type) VALUES ('peter-rabbit-01','peter-rabbit','The Tale of Peter Rabbit','published','free')");
    const version = await client.query("INSERT INTO content_versions(piece_id,content_version,status,publishable,manifest_sha256,published_at) VALUES ('peter-rabbit-01',1,'published',true,$1,now()) RETURNING id", [hash(manifestBytes)]);
    await client.query("UPDATE pieces SET current_content_version_id=$1 WHERE id='peter-rabbit-01'", [version.rows[0].id]);
    for (const asset of assets) {
      const key = `device-fixture/peter-rabbit-01/v1/${hash(asset.bytes)}/${path.basename(asset.file)}`;
      await s3.send(new PutObjectCommand({ Bucket: process.env.OBJECT_STORAGE_BUCKET_PUBLISHED, Key: key, Body: asset.bytes, ContentType: asset.mime }));
      await client.query("INSERT INTO content_assets(piece_id,content_version,asset_type,bucket,object_key,sha256,size_bytes,mime_type,duration_ms,status) VALUES ('peter-rabbit-01',1,$1,$2,$3,$4,$5,$6,$7,'published')", [asset.type, process.env.OBJECT_STORAGE_BUCKET_PUBLISHED, key, hash(asset.bytes), asset.bytes.length, asset.mime, asset.type === 'audio' ? manifest.audio.durationMs : null]);
    }
    const pack = await client.query("INSERT INTO quiz_packages(piece_id,content_version,quiz_version,package_sha256,status,mastery_threshold,published_at) VALUES ('peter-rabbit-01',1,1,$1,'published',$2,now()) RETURNING id", [hash(quizBytes), quiz.masteryFeedbackPercent]);
    for (const [index, question] of quiz.questions.entries()) await client.query('INSERT INTO quiz_questions(quiz_package_id,question_id,prompt,options,correct_option,sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [pack.rows[0].id, question.id, question.q, JSON.stringify(question.options), question.answer, index]);
    await client.query('COMMIT');
    const record = { internalFixtureOnly: true, sourcePublishable: manifest.publishable, sourceStatus: manifest.status, sourceBlockers: manifest.blockers, manifestSha256: hash(manifestBytes), quizSha256: hash(quizBytes), assetCount: assets.length, questions: quiz.questions.length };
    fs.writeFileSync(path.join(repo, '.cache/device-local/content-fixture.json'), JSON.stringify(record, null, 2));
    console.log('Device-local content fixture seeded: real assets=6 questions=10; source release gates unchanged');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); s3.destroy(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
