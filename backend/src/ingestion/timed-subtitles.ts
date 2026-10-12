// Narration-oriented import, not a browser WebVTT renderer. Never repair or retime invalid cues.
export const normalizedSubtitleLimit = 8 * 1024 * 1024;
export const timedSubtitleConverterVersion = "timed-subtitles-v1";
type Format = "vtt" | "srt";
export class SubtitleNormalizationError extends Error {
  constructor(message: string) { super(message); this.name = "SubtitleNormalizationError"; }
}
const invalid = (message: string): never => { throw new SubtitleNormalizationError(message); };

export function timedSubtitleFormat(mime: string, fileName: string): Format | null {
  if (mime === "text/vtt") return "vtt";
  if (mime === "application/x-subrip") return "srt";
  if (mime === "text/plain" || mime === "application/octet-stream") {
    if (/\.vtt$/i.test(fileName)) return "vtt";
    if (/\.srt$/i.test(fileName)) return "srt";
  }
  return null;
}

async function* lines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  function decode(chunk?: Uint8Array, stream = false) {
    try { return decoder.decode(chunk, { stream }); }
    catch { return invalid("Subtitle source must be valid UTF-8"); }
  }
  for await (const chunk of chunks) {
    pending += decode(chunk, true);
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const ch = pending[i];
      if (ch !== "\r" && ch !== "\n") continue;
      // A CR at a chunk boundary may be the first half of CRLF.
      if (ch === "\r" && i === pending.length - 1) break;
      if (i - start > 65536) invalid("Subtitle line exceeds 65536 characters");
      yield pending.slice(start, i);
      if (ch === "\r" && pending[i + 1] === "\n") i++;
      start = i + 1;
    }
    pending = pending.slice(start);
    if (pending.length > 65537) invalid("Subtitle line exceeds 65536 characters");
  }
  pending += decode();
  if (pending.endsWith("\r")) pending = pending.slice(0, -1);
  if (pending.length > 65536) invalid("Subtitle line exceeds 65536 characters");
  if (pending) yield pending;
}

function timestamp(text: string, format: Format): number {
  const expression = format === "vtt" ? /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/ : /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/;
  const m = expression.exec(text);
  if (!m) invalid("Subtitle timestamp is invalid");
  const ms = ((Number(m![1] || 0) * 60 + Number(m![2])) * 60 + Number(m![3])) * 1000 + Number(m![4]);
  if (!Number.isSafeInteger(ms)) invalid("Subtitle timestamp exceeds integer precision");
  return ms;
}

function entities(text: string): string {
  const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: "\u00a0", lrm: "\u200e", rlm: "\u200f", quot: '"', apos: "'" };
  return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]*);/gi, (whole, name: string) => {
    if (name[0] !== "#") {
      if (!(name in names)) invalid("Unsupported subtitle character entity; normalize it to Unicode first");
      return names[name]!;
    }
    const point = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!Number.isInteger(point) || point < 32 || point === 127 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) invalid("Subtitle character entity is invalid");
    return String.fromCodePoint(point);
  });
}

type Presentation = { blocks: number; settings: number; tags: number; timestamps: number };
function plainText(value: string, format: Format, startMs: number, endMs: number, discarded: Presentation): string {
  let lastTimestamp = startMs;
  const text = value.replace(/<([^<>]*)>/g, (_whole, tag: string) => {
    if (/^[\d:]+\./.test(tag)) {
      if (format !== "vtt") invalid("SRT inline timestamps are unsupported");
      const at = timestamp(tag, "vtt");
      if (at <= lastTimestamp || at >= endMs) invalid("Inline subtitle timestamp is outside its cue or out of order");
      lastTimestamp = at; discarded.timestamps++; return "";
    }
    // Only presentation components are removed. Ruby/unknown markup needs an explicit reviewed conversion.
    if (!/^\/?(?:b|i|u|c)(?:\.[\w-]+)*$/.test(tag) &&
        !/^(?:v|lang)(?:\.[\w-]+)*(?:[ \t]+[^<>]+)?$/.test(tag) && !/^\/(?:v|lang)$/.test(tag) &&
        !(format === "srt" && /^\/?font(?:[ \t]+color=(?:"[^"<>]+"|'[^'<>]+'|[^\s<>]+))?$/.test(tag))) invalid("Unsupported subtitle markup");
    discarded.tags++; return "";
  });
  if (text.includes("<")) invalid("Unescaped or malformed subtitle markup");
  const result = entities(text).trim();
  if (!result || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) invalid("Subtitle cue text is empty or contains control characters");
  return result;
}

export async function normalizeTimedSubtitles(chunks: AsyncIterable<Uint8Array>, format: Format) {
  let header = format === "vtt", firstLine = true, skipped = false, blockSize = 0, previousEnd = -1, cueCount = 0, sizeBytes = 2;
  let block: string[] = [];
  const ids = new Set<string>(), parts: Buffer[] = [], discarded: Presentation = { blocks: 0, settings: 0, tags: 0, timestamps: 0 };
  function flush() {
    if (skipped) { skipped = false; block = []; blockSize = 0; return; }
    if (!block.length) return;
    let index = 0, id: string;
    if (block[0]!.includes("-->")) {
      if (format === "srt") invalid("SRT cue sequence number is missing");
      id = "c" + String(cueCount + 1).padStart(4, "0");
    } else {
      const sourceId = block[index++]!;
      if (!sourceId.trim() || sourceId.length > 128) invalid("Subtitle cue identifier is invalid");
      if (format === "srt" && !/^\d+$/.test(sourceId)) invalid("SRT cue sequence number is invalid");
      id = format === "srt" ? "c" + BigInt(sourceId).toString().padStart(4, "0") : sourceId;
    }
    if (ids.has(id)) invalid("Duplicate subtitle cue identifier");
    const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(block[index++] ?? "");
    if (!timing) invalid("Subtitle cue timings are missing or malformed");
    const startMs = timestamp(timing![1]!, format), endMs = timestamp(timing![2]!, format);
    if (startMs < previousEnd || endMs <= startMs) invalid("Subtitle cues overlap, are out of order or have invalid duration");
    if (timing![3]) {
      if (format !== "vtt" || timing![3]!.split(/[ \t]+/).some(setting => !/^(?:vertical|line|position|size|align|region):[^\s]+$/.test(setting))) invalid("Unsupported subtitle cue settings");
      discarded.settings++;
    }
    if (index >= block.length || block.slice(index).some(line => line.includes("-->"))) invalid("Subtitle cue text is missing or cue separator is absent");
    const text = plainText(block.slice(index).join("\n"), format, startMs, endMs, discarded);
    // Empty tokens explicitly disable the client's legacy surface-word guessing.
    const encoded = Buffer.from(JSON.stringify({ id, startMs, endMs, text, tokens: [] }), "utf8");
    sizeBytes += encoded.length + (cueCount ? 1 : 0);
    if (sizeBytes > normalizedSubtitleLimit) invalid("Normalized subtitle JSON exceeds the reader 8 MiB limit; split into chapters");
    ids.add(id); parts.push(encoded); cueCount++; previousEnd = endMs; block = []; blockSize = 0;
  }
  for await (const line of lines(chunks)) {
    if (firstLine) {
      firstLine = false;
      if (format === "vtt") { if (!/^WEBVTT(?:[ \t].*)?$/.test(line) || line.includes("-->")) invalid("WebVTT header is missing or invalid"); continue; }
    }
    if (header) {
      if (!line.trim()) header = false;
      else if (/X-TIMESTAMP-MAP/i.test(line)) invalid("External timestamp maps need an explicit audio-clock conversion");
      else if (line.includes("-->")) invalid("WebVTT header separator is missing");
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (skipped) continue;
    if (!block.length && format === "vtt" && (/^NOTE(?:[ \t]|$)/.test(line) || line === "STYLE" || line === "REGION")) {
      if ((line === "STYLE" || line === "REGION") && cueCount) invalid("WebVTT presentation blocks must precede cues");
      skipped = true; discarded.blocks++; continue;
    }
    blockSize += line.length + 1;
    if (blockSize > 65536) invalid("Subtitle cue exceeds 65536 characters");
    block.push(line);
  }
  flush();
  if (!cueCount) invalid("Subtitle source contains no valid cues");
  const chunksOut: Buffer[] = [Buffer.from("[")];
  for (const [i, part] of parts.entries()) { if (i) chunksOut.push(Buffer.from(",")); chunksOut.push(part); }
  chunksOut.push(Buffer.from("]"));
  return { bytes: Buffer.concat(chunksOut, sizeBytes), cueCount, lastEndMs: previousEnd,
    conversion: { converterVersion: timedSubtitleConverterVersion, sourceFormat: format, plainText: true, discardedPresentation: discarded } };
}
