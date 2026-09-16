import json, wave
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
catalog = json.loads((ROOT/'modules/listen-read/content/stories.json').read_text(encoding='utf-8'))
output = ROOT/'assets/quiz-audio'
output.mkdir(parents=True, exist_ok=True)
for book in catalog['books']:
    for chapter in book['chapters']:
        for qi, question in enumerate(chapter['quiz']):
            for oi, _ in enumerate(question['options']):
                name = f'{chapter["id"]}-{qi}-{oi}.wav'
                with wave.open(str(ROOT/'tools/quiz-audio-parts'/name), 'rb') as source:
                    rate = source.getframerate()
                    assert source.getnchannels() == 1 and source.getsampwidth() == 1
                    raw = source.readframes(source.getnframes())
                active = [i for i, v in enumerate(raw) if abs(v - 128) > 3]
                start = max(0, active[0] - int(rate * .07)) if active else 0
                end = min(len(raw), active[-1] + int(rate * .12)) if active else len(raw)
                with wave.open(str(output/name), 'wb') as target:
                    target.setnchannels(1); target.setsampwidth(1); target.setframerate(rate)
                    target.writeframes(raw[start:end] + bytes([128]) * int(rate * .14))
print('Option files:', len(list(output.glob('*.wav'))))
print('Option audio bytes:', sum(p.stat().st_size for p in output.glob('*.wav')))
