"""Build chapter-specific offline glosses from the reviewed TSV source."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / 'tools/oz-glosses.tsv'
entries = {}
for number, line in enumerate(source.read_text(encoding='utf-8').splitlines(), 1):
    if not line.strip():
        continue
    try:
        word, meaning = line.split('\t', 1)
    except ValueError as exc:
        raise ValueError(f'Bad glossary row {number}') from exc
    if word in entries or not word or not meaning:
        raise ValueError(f'Bad or duplicate glossary word at {number}: {word}')
    entries[word] = {'lemma': word, 'zh': meaning}

target = root / 'modules/listen-read/content/oz-dictionary.json'
target.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print('Built', len(entries), 'Oz glosses')
