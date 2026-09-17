const MAX_CHARACTERS = 40
const VISIBLE_ROWS = 7

function splitText(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  words.forEach(word => {
    while (word.length > MAX_CHARACTERS) {
      if (line) { lines.push(line); line = '' }
      lines.push(word.slice(0, MAX_CHARACTERS))
      word = word.slice(MAX_CHARACTERS)
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= MAX_CHARACTERS) line += ' ' + word
    else { lines.push(line); line = word }
  })
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function tokens(text) {
  return text.split(/([A-Za-z]+(?:['-][A-Za-z]+)*)/).filter(Boolean)
    .map((value, id) => ({ id, value, word: /^[A-Za-z]/.test(value) }))
}

function prepare(cues) {
  const lines = [], starts = [], counts = []
  cues.forEach((cue, cueIndex) => {
    starts.push(lines.length)
    const parts = splitText(cue.text)
    counts.push(parts.length)
    parts.forEach(text => lines.push({ text, cueIndex, tokens: tokens(text) }))
  })
  return { lines, starts, counts }
}

function display(layout, cues, current, position) {
  let focus = 0
  if (current >= 0) {
    const cue = cues[current]
    const count = layout.counts[current]
    let shift = 0
    if (count > VISIBLE_ROWS - 1) {
      const elapsed = Math.max(0, Math.min(1, (position - cue.start) / (cue.end - cue.start)))
      const spokenLine = Math.min(count - 1, Math.floor(elapsed * count))
      shift = Math.min(count - (VISIBLE_ROWS - 2), Math.max(0, spokenLine - (VISIBLE_ROWS - 3)))
    }
    focus = layout.starts[current] + shift
  } else if (position >= cues[cues.length - 1].end) {
    focus = layout.lines.length - 1
  } else {
    const next = cues.findIndex(cue => cue.start > position)
    focus = layout.starts[Math.max(0, next)] || 0
  }
  const start = focus - 1
  const rows = Array.from({ length: VISIBLE_ROWS }, (_, slot) => {
    const line = layout.lines[start + slot]
    return line ? Object.assign({ slot, edge: slot === 0 || slot === VISIBLE_ROWS - 1, active: line.cueIndex === current }, line)
      : { slot, edge: slot === 0 || slot === VISIBLE_ROWS - 1, active: false, empty: true, text: '', tokens: [] }
  })
  return { start, rows }
}

module.exports = { MAX_CHARACTERS, VISIBLE_ROWS, splitText, prepare, display }
