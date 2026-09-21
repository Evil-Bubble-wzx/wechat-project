import argparse
import json
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate word timestamps with Faster-Whisper.")
    parser.add_argument("package_dir", type=Path)
    parser.add_argument("--model", default="base.en")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parents[2]
    dependency_dir = project_dir / ".tools" / "faster-whisper"
    model_dir = project_dir / ".models" / "faster-whisper"
    sys.path.insert(0, str(dependency_dir))

    from faster_whisper import WhisperModel

    package_dir = args.package_dir.resolve()
    audio_path = package_dir / "source" / "audio-original.mp3"
    output_path = package_dir / "work" / "asr-words.json"
    if not audio_path.exists():
        raise FileNotFoundError(audio_path)

    model_dir.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=str(model_dir),
        cpu_threads=4,
        num_workers=1,
    )

    segments_iterator, info = model.transcribe(
        str(audio_path),
        language="en",
        beam_size=5,
        best_of=5,
        temperature=0,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
    )

    segments = []
    words = []
    for segment_index, segment in enumerate(segments_iterator):
        segment_words = []
        for word_index, word in enumerate(segment.words or []):
            item = {
                "id": f"s{segment_index:04d}:w{word_index:03d}",
                "surface": word.word,
                "startMs": round(word.start * 1000),
                "endMs": round(word.end * 1000),
                "probability": round(float(word.probability), 6),
                "segmentIndex": segment_index,
            }
            segment_words.append(item)
            words.append(item)

        segments.append({
            "id": f"s{segment_index:04d}",
            "startMs": round(segment.start * 1000),
            "endMs": round(segment.end * 1000),
            "text": segment.text.strip(),
            "avgLogprob": round(float(segment.avg_logprob), 6),
            "noSpeechProbability": round(float(segment.no_speech_prob), 6),
            "words": segment_words,
        })
        print(f"segment {segment_index + 1}: {segment.start:.2f}-{segment.end:.2f}s {segment.text.strip()}", flush=True)

    payload = {
        "schemaVersion": 1,
        "pieceId": "peter-rabbit-01",
        "engine": "faster-whisper",
        "model": args.model,
        "device": "cpu",
        "computeType": "int8",
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 6),
        "durationMs": round(float(info.duration) * 1000),
        "durationAfterVadMs": round(float(info.duration_after_vad) * 1000),
        "segments": segments,
        "words": words,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "segments": len(segments),
        "words": len(words),
        "language": info.language,
    }, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
