import json, wave
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
data = json.loads((ROOT / 'modules/listen-read/content/stories.json').read_text(encoding='utf-8'))
out = ROOT / 'assets/audio'
out.mkdir(parents=True, exist_ok=True)
timings = {}
for book in data['books']:
    for ch in book['chapters']:
        frames, cues, cursor = [], [], 0
        for i, sentence in enumerate(ch['sentences']):
            with wave.open(str(ROOT / f"tools/audio-parts/{ch['id']}-{i}.wav"), 'rb') as f:
                rate, channels, width = f.getframerate(), f.getnchannels(), f.getsampwidth()
                raw = f.readframes(f.getnframes())
                # Trim synthesis padding to create exact, short gaps between sentences.
                assert width == 1 and channels == 1
                active = [j for j,v in enumerate(raw) if abs(v - 128) > 3]
                start = max(0, active[0] - int(rate * .08)) if active else 0
                end = min(len(raw), active[-1] + int(rate * .12)) if active else len(raw)
                raw = raw[start:end] + bytes([128]) * int(rate * .32)
                length = len(raw) / rate
                cues.append({'start': round(cursor, 4), 'end': round(cursor + length, 4)})
                cursor += length
                frames.append(raw)
        with wave.open(str(out / (ch['id'] + '.wav')), 'wb') as f:
            f.setnchannels(1); f.setsampwidth(1); f.setframerate(rate); f.writeframes(b''.join(frames))
        timings[ch['id']] = {'duration': round(cursor, 4), 'cues': cues}
(ROOT / 'modules/listen-read/content/timings.json').write_text(json.dumps(timings, indent=2), encoding='utf-8')
print(json.dumps({k: v['duration'] for k,v in timings.items()}))
print('Audio bytes:', sum(p.stat().st_size for p in out.glob('*.wav')))
