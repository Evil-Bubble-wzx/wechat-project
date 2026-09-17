"""Make a reviewable ASR transcript with word timestamps for the Oz recording."""
import json
import sys
from pathlib import Path
from faster_whisper import WhisperModel

ROOT = Path(__file__).resolve().parents[1]
model_name = sys.argv[1] if len(sys.argv) > 1 else 'tiny.en'
model = WhisperModel(model_name, device='cpu', compute_type='int8', download_root=str(ROOT / 'tools/.models'))
audio = str(ROOT / 'book/The Wonderful Wizard of Oz/video/21179-02.ogg')
segments, info = model.transcribe(audio, language='en', beam_size=5, word_timestamps=True, vad_filter=False)
data = []
for segment in segments:
    print(f'{segment.start:6.1f}-{segment.end:6.1f} {segment.text}', flush=True)
    data.append({'start': segment.start, 'end': segment.end, 'text': segment.text.strip(),
                 'words': [{'start': w.start, 'end': w.end, 'word': w.word} for w in segment.words]})
(ROOT / ('tools/oz-transcript-' + model_name + '.json')).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
print('Language:', info.language, 'segments:', len(data), flush=True)
