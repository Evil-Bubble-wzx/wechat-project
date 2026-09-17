"""Extract chapter I from the bundled Gutenberg EPUB for audio alignment."""
import json
import re
import zipfile
from pathlib import Path
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
epub = ROOT / 'book/The Wonderful Wizard of Oz/text/pg43936-images-3.epub'
with zipfile.ZipFile(epub) as archive:
    name = next(n for n in archive.namelist() if n.endswith('43936-h-1.htm.xhtml'))
    soup = BeautifulSoup(archive.read(name), 'html.parser')

start = soup.find(id='Chapter_I').sourceline
end = soup.find(id='Chapter_II').sourceline
paragraphs = []
for node in soup.find_all('p'):
    if start < node.sourceline < end:
        value = re.sub(r'\s+', ' ', node.get_text(' ', strip=True)).strip()
        if value and value != '" She caught Toto by the ear. "':
            paragraphs.append(value)

sentences = []
for paragraph in paragraphs:
    sentences.extend(s.strip() for s in re.split(r'(?<=[.!?])\s+(?=["“A-Z])', paragraph) if s.strip())

out = ROOT / 'tools/oz-source.json'
out.write_text(json.dumps({'paragraphs': paragraphs, 'sentences': sentences}, indent=2, ensure_ascii=False), encoding='utf-8')
print(len(paragraphs), 'paragraphs,', len(sentences), 'sentences,', sum(len(s.split()) for s in sentences), 'words')
print('First:', sentences[:5])
print('Last:', sentences[-3:])
