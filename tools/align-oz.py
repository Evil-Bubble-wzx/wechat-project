"""Match EPUB words to locally transcribed word timestamps."""
import difflib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = json.loads((ROOT / 'tools/oz-source.json').read_text(encoding='utf-8'))['sentences']
segments = json.loads((ROOT / 'tools/oz-transcript-tiny.en.json').read_text(encoding='utf-8'))
spoken = [w for segment in segments for w in segment['words']]

def tokens(text):
    return re.findall(r"[a-z]+(?:'[a-z]+)?", text.lower())

source_words = []
sentence_ranges = []
for sentence in source:
    start = len(source_words)
    source_words.extend(tokens(sentence))
    sentence_ranges.append((start, len(source_words)))

spoken_words = []
spoken_indexes = []
for index, word in enumerate(spoken):
    for token in tokens(word['word']):
        spoken_words.append(token)
        spoken_indexes.append(index)

# The recording starts after the LibriVox introduction and chapter heading.
offset = next(i for i, w in enumerate(spoken_words) if w == 'dorothy' and spoken[spoken_indexes[i]]['start'] > 20)
matcher = difflib.SequenceMatcher(None, source_words, spoken_words[offset:], autojunk=False)
matched = {}
for source_index, asr_index, size in matcher.get_matching_blocks():
    for delta in range(size):
        matched[source_index + delta] = spoken_indexes[offset + asr_index + delta]

cues = []
for sentence, (first, after) in zip(source, sentence_ranges):
    hits = [matched[i] for i in range(first, after) if i in matched]
    if not hits:
        raise RuntimeError('No matched speech for: ' + sentence)
    cues.append({'start': round(spoken[min(hits)]['start'], 2),
                 'end': round(spoken[max(hits)]['end'], 2),
                 'matchedWords': len(hits), 'totalWords': after - first,
                 'text': sentence})

for i, cue in enumerate(cues):
    if i and cue['start'] < cues[i-1]['end']:
        raise RuntimeError('Overlapping cues')

result = {'title': {'start': 20.36, 'end': 22.2, 'text': 'Chapter I. The Cyclone.'},
          'cues': cues, 'matchedWords': len(matched), 'totalWords': len(source_words)}
(ROOT / 'tools/oz-alignment-review.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
print(f"Matched {len(matched)}/{len(source_words)} source words")
for i, cue in enumerate(cues):
    print(f"{i+1:02} {cue['start']:6.2f}-{cue['end']:6.2f} {cue['matchedWords']:2}/{cue['totalWords']:2} {cue['text'][:65]}")
