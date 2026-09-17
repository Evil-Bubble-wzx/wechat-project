"""Convert packaged demo WAV files to compact speech MP3 files.

Requires imageio-ffmpeg (or an ffmpeg executable on PATH). Source WAVs for
regeneration live under tools/audio-parts and tools/quiz-audio-parts.
"""
import shutil
import subprocess
from pathlib import Path

try:
    from imageio_ffmpeg import get_ffmpeg_exe
    ffmpeg = get_ffmpeg_exe()
except ImportError:
    ffmpeg = shutil.which('ffmpeg')
if not ffmpeg:
    raise SystemExit('Install imageio-ffmpeg or add ffmpeg to PATH')

root = Path(__file__).resolve().parents[1]
for folder in (root / 'assets/audio', root / 'assets/quiz-audio'):
    for source in folder.glob('*.wav'):
        target = source.with_suffix('.mp3')
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
                        '-i', str(source), '-ac', '1', '-ar', '22050',
                        '-codec:a', 'libmp3lame', '-b:a', '48k', str(target)], check=True)
        if not target.is_file() or not target.stat().st_size:
            raise RuntimeError('Missing encoded audio: ' + str(target))
        source.unlink()
        print(target.relative_to(root))
