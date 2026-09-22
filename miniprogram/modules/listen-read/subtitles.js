const MAX_CHARACTERS = 40
const VISIBLE_ROWS = 7

function splitText(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (let word of words) {
    while (word.length > MAX_CHARACTERS) {
      if (line) { lines.push(line); line = '' }
      lines.push(word.slice(0, MAX_CHARACTERS))
      word = word.slice(MAX_CHARACTERS)
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= MAX_CHARACTERS) line += ' ' + word
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function lineTokens(text) {
  return text.split(/([A-Za-z]+(?:[’'-][A-Za-z]+)*)/).filter(Boolean).map((surface, id) => {
    const key = surface.toLowerCase().replace(/[’]/g, "'")
    return { id, surface, vocabKey: /^[a-z]/.test(key) ? key : null }
  })
}

function cueTokensInRange(cue, start, end, lineIndex) {
  if (!Array.isArray(cue.tokens)) return lineTokens(cue.text.slice(start, end))
  const result = []
  let offset = 0
  for (const token of cue.tokens) {
    const tokenStart = offset
    const tokenEnd = offset + token.surface.length
    offset = tokenEnd
    const overlapStart = Math.max(start, tokenStart)
    const overlapEnd = Math.min(end, tokenEnd)
    if (overlapStart >= overlapEnd) continue
    result.push({
      id: token.id + ':l' + lineIndex,
      surface: token.surface.slice(overlapStart - tokenStart, overlapEnd - tokenStart),
      vocabKey: token.vocabKey || null
    })
  }
  return result
}

function prepare(cues) {
  const lines = [], starts = [], counts = []
  for (const [cueIndex, cue] of cues.entries()) {
    starts.push(lines.length)
    const parts = splitText(cue.text)
    counts.push(parts.length)
    let cursor = 0
    for (const [lineIndex, text] of parts.entries()) {
      const start = cue.text.indexOf(text, cursor)
      const safeStart = start >= 0 ? start : cursor
      const end = safeStart + text.length
      cursor = end
      lines.push({ text, cueIndex, tokens: cueTokensInRange(cue, safeStart, end, lineIndex) })
    }
  }
  return { lines, starts, counts }
}

function currentIndex(cues, positionMs) {
  let low = 0, high = cues.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (cues[middle].startMs <= positionMs) low = middle + 1
    else high = middle - 1
  }
  return high
}

function display(layout, cues, positionMs) {
  if (!cues.length) return { start: 0, current: -1, rows: Array.from({ length: VISIBLE_ROWS }, (_, slot) => ({ slot, edge: slot === 0 || slot === 6, empty: true, active: false, tokens: [] })) }
  const current = currentIndex(cues, positionMs)
  let focus = 0
  if (current >= 0) {
    const cue = cues[current]
    const count = layout.counts[current]
    let shift = 0
    if (count > VISIBLE_ROWS - 1) {
      const elapsed = Math.max(0, Math.min(1, (positionMs - cue.startMs) / Math.max(1, cue.endMs - cue.startMs)))
      const spokenLine = Math.min(count - 1, Math.floor(elapsed * count))
      shift = Math.min(count - (VISIBLE_ROWS - 2), Math.max(0, spokenLine - (VISIBLE_ROWS - 3)))
    }
    focus = layout.starts[current] + shift
  }
  const start = focus - 1
  const rows = Array.from({ length: VISIBLE_ROWS }, (_, slot) => {
    const line = layout.lines[start + slot]
    return line ? Object.assign({ slot, edge: slot === 0 || slot === VISIBLE_ROWS - 1, active: line.cueIndex === current }, line)
      : { slot, edge: slot === 0 || slot === VISIBLE_ROWS - 1, active: false, empty: true, text: '', tokens: [] }
  })
  return { start, current, rows }
}

module.exports = { MAX_CHARACTERS, VISIBLE_ROWS, splitText, prepare, display }
