import assert from "node:assert/strict";
import test from "node:test";
import {normalizeTimedSubtitles,timedSubtitleFormat,SubtitleNormalizationError,normalizedSubtitleLimit} from "../src/ingestion/timed-subtitles.ts";
import {assertReaderAssetDeclaration,validateSubtitleJson} from "../src/ingestion/processor.ts";
import {validateSubtitleReferences} from "../src/content/package-validation.ts";

async function* chunks(text: string, size = 7) { const bytes = Buffer.from(text); for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); }
const vtt = (body: string) => "WEBVTT\n\n" + body;
const normalize = (text: string, format: "vtt" | "srt" = "vtt", size = 7) => normalizeTimedSubtitles(chunks(text, size), format);
const invalid = (error: unknown) => error instanceof SubtitleNormalizationError;

test("timed subtitle input MIME and filename selection never guesses arbitrary text or overrides JSON", () => {
  assert.equal(timedSubtitleFormat("text/vtt", "subtitles.bin"), "vtt");
  assert.equal(timedSubtitleFormat("application/x-subrip", "subtitles.bin"), "srt");
  assert.equal(timedSubtitleFormat("text/plain", "SUBTITLE.SRT"), "srt");
  assert.equal(timedSubtitleFormat("application/octet-stream", "subtitle.vtt"), "vtt");
  assert.equal(timedSubtitleFormat("application/json", "subtitle.srt"), null);
  assert.equal(timedSubtitleFormat("text/plain", "caption.txt"), null);
});

test("WebVTT preserves source IDs, millisecond times and multilingual multiline text across byte boundaries", async () => {
  const result = await normalize("\ufeffWEBVTT Narration\r\n\r\nchapter-one\r\n00:00.100 --> 00:01.200\r\n你好, café &amp; tea.\r\nSecond line.\r\n\r\n00:01.200 --> 00:02.000\r\nEnd.\r\n", "vtt", 1);
  const cues = JSON.parse(result.bytes.toString());
  assert.deepEqual(cues[0], {id:"chapter-one", startMs:100, endMs:1200, text:"你好, café & tea.\nSecond line.", tokens:[]});
  assert.equal(cues[1].id, "c0002"); assert.equal(result.cueCount, 2); assert.equal(result.lastEndMs, 2000);
  assert.deepEqual(validateSubtitleJson(cues), {cueCount:2,lastEndMs:2000});
  assert.deepEqual(validateSubtitleReferences(cues).vocabularyReferences, []);
});

test("SRT handles BOM, CR-only lines, numeric IDs, standard comma and common decimal-dot timestamps", async () => {
  const result = await normalize("\ufeff1\r00:00:01,001 --> 00:00:02,002\rFirst.\r\r2\r01:02:03.456 --> 01:02:04.000\r<font color=\"green\"><i>Last.</i></font>\r", "srt", 3);
  const cues = JSON.parse(result.bytes.toString()); assert.equal(cues[0].id, "c0001"); assert.equal(cues[0].startMs, 1001);
  assert.equal(cues[1].startMs, 3723456); assert.equal(cues[1].text, "Last."); assert.equal(result.conversion.discardedPresentation.tags, 4);
});

test("comments, styles, regions, cue settings and presentation markup are counted, not executed", async () => {
  const result = await normalize(vtt("NOTE importer note\nprivate ignored note\n\nSTYLE\n::cue {color:red}\n\nREGION\nid:bottom\n\nintro\n00:00.000 --> 00:03.000 align:start line:90%\n<v Speaker><c.green><b>A</b></c><00:01.000> &lt;B&gt; &#233; &#x1F600; 2 > 1\n"));
  assert.equal(JSON.parse(result.bytes.toString())[0].text, "A <B> é 😀 2 > 1");
  assert.deepEqual(result.conversion.discardedPresentation, {blocks:3,settings:1,tags:5,timestamps:1});
});

test("malformed timing, overlap, duplicate IDs, missing separators and empty payload fail without repairs", async () => {
  for (const body of [
    "c1\n00:00.000 --> 00:01.000\n", "c1\n00:00.000 --> 00:00.000\nA", "c1\n00:60.000 --> 01:01.000\nA",
    "c1\n00:02.000 --> 00:03.000\nA\n\nc2\n00:01.000 --> 00:02.000\nB",
    "c1\n00:00.000 --> 00:02.000\nA\n\nc2\n00:01.000 --> 00:03.000\nB",
    "c1\n00:00.000 --> 00:01.000\nA\n\nc1\n00:01.000 --> 00:02.000\nB",
    "00:00.000 --> 00:01.000\nA\n00:01.000 --> 00:02.000\nB",
    "9007199254740993:00:00.000 --> 9007199254740994:00:00.000\nA",
  ]) await assert.rejects(normalize(vtt(body)), invalid);
  await assert.rejects(normalize("1\n00:00:00,000 --> 00:00:01,000\nA\n\n01\n00:00:01,000 --> 00:00:02,000\nB", "srt"), invalid);
});

test("unsupported markup, external clock maps, controls and invalid inline times fail explicitly", async () => {
  for (const text of ["<script>alert(1)</script>","<ruby>A<rt>B</rt></ruby>","A\u0000B","&#0;","&#xD800;","&unknown;","A <broken","A<00:00.000>B","A<00:01.000>B","A<00:00.700>B<00:00.600>C"])
    await assert.rejects(normalize(vtt("00:00.000 --> 00:01.000\n" + text)), invalid);
  await assert.rejects(normalize("WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:900000\n\n00:00.000 --> 00:01.000\nA"), invalid);
  await assert.rejects(normalize(vtt("00:00.000 --> 00:01.000 unexpected:value\nA")), invalid);
  await assert.rejects(normalize("WEBVTT\n00:00.000 --> 00:01.000\nA"), invalid);
  await assert.rejects(normalize("not WEBVTT\n\n00:00.000 --> 00:01.000\nA"), invalid);
});

test("invalid UTF-8 and oversized lines/cues are rejected with bounded parsing", async () => {
  await assert.rejects(normalizeTimedSubtitles((async function* () { yield Buffer.from([0xc3]); })(), "srt"), /UTF-8/);
  await assert.rejects(normalize(vtt("00:00.000 --> 00:01.000\n" + "x".repeat(65537)), "vtt", 4096), /65536/);
  await assert.rejects(normalize(vtt("00:00.000 --> 00:01.000\n" + ("x".repeat(40000) + "\n").repeat(2)), "vtt", 4096), /65536/);
});

test("temporary source I/O errors are not classified as invalid subtitle content", async () => {
  const ioError = new Error("temporary read failure");
  await assert.rejects(normalizeTimedSubtitles((async function* () { yield Buffer.from("WEBVTT\n\n"); throw ioError; })(), "vtt"), error => error === ioError);
});

test("raw inputs over 8 MiB stream through ignored comments while reader output remains small", async () => {
  async function* largeSource() { yield Buffer.from("WEBVTT\n\nNOTE large comments\n"); const chunk=Buffer.from("x".repeat(32000)+"\n"); for(let i=0;i<300;i++) yield chunk; yield Buffer.from("\n00:00.000 --> 00:01.000\nA\n"); }
  const result = await normalizeTimedSubtitles(largeSource(), "vtt"); assert.equal(result.cueCount, 1); assert.ok(result.bytes.length < 100);
});

test("expanding subtitle JSON cannot exceed the client resource limit", async () => {
  async function* expanding() { yield Buffer.from("WEBVTT\n\n"); for(let i=0;i<18000;i++) { const h=String(Math.floor(i/3600)).padStart(2,"0"), m=String(Math.floor(i/60)%60).padStart(2,"0"), s=String(i%60).padStart(2,"0"); yield Buffer.from(`${h}:${m}:${s}.000 --> ${h}:${m}:${s}.999\n${"x".repeat(512)}\n\n`); } }
  await assert.rejects(normalizeTimedSubtitles(expanding(), "vtt"), /8 MiB/);
});

test("worker validates raw and JSON declarations before allocating/downloading reader resources", () => {
  assert.doesNotThrow(()=>assertReaderAssetDeclaration("subtitles","text/vtt","track.vtt",100*1024*1024));
  assert.doesNotThrow(()=>assertReaderAssetDeclaration("subtitles","text/plain","track.srt",1024));
  assert.doesNotThrow(()=>assertReaderAssetDeclaration("subtitles","application/json","track.json",normalizedSubtitleLimit));
  for(const [type,mime,name,size] of [["subtitles","text/vtt","track.vtt",100*1024*1024+1],["subtitles","text/plain","track.txt",100], ["subtitles","application/json","track.json",normalizedSubtitleLimit+1], ["quiz","text/vtt","track.vtt",100]] as const)
    assert.throws(()=>assertReaderAssetDeclaration(type,mime,name,size));
});
