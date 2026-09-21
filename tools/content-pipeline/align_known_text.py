import argparse
import json
import re
from pathlib import Path


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower().replace("’", "'"))


def edit_distance_at_most_one(left: str, right: str) -> bool:
    if left == right:
        return True
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        return sum(a != b for a, b in zip(left, right)) <= 1
    short, long = (left, right) if len(left) < len(right) else (right, left)
    short_index = 0
    long_index = 0
    edits = 0
    while short_index < len(short) and long_index < len(long):
        if short[short_index] == long[long_index]:
            short_index += 1
            long_index += 1
        else:
            edits += 1
            long_index += 1
            if edits > 1:
                return False
    return True


def similarity_kind(canonical: str, recognized: str):
    if canonical == recognized:
        return "exact", 1.0, 4.0
    if min(len(canonical), len(recognized)) >= 4 and edit_distance_at_most_one(canonical, recognized):
        return "fuzzy", 0.82, 1.8
    if min(len(canonical), len(recognized)) >= 5 and (
        canonical.startswith(recognized) or recognized.startswith(canonical)
    ):
        return "fuzzy", 0.72, 1.2
    return "substitution", 0.0, -3.0


def align_words(canonical_words, asr_words):
    canonical_norm = [normalize(item["surface"]) for item in canonical_words]
    asr_norm = [normalize(item["surface"]) for item in asr_words]
    canonical_gap = 2.0
    asr_gap = 1.4
    width = len(asr_words) + 1

    previous = [0.0] * width
    traces = [bytearray([2] * width)]
    traces[0][0] = 0

    for canonical_index, canonical in enumerate(canonical_norm, start=1):
        current = [-canonical_gap * canonical_index] + [0.0] * (width - 1)
        trace = bytearray(width)
        trace[0] = 1
        for asr_index, recognized in enumerate(asr_norm, start=1):
            _, _, match_score = similarity_kind(canonical, recognized)
            diagonal = previous[asr_index - 1] + match_score
            up = previous[asr_index] - canonical_gap
            left = current[asr_index - 1] - asr_gap
            if diagonal >= up and diagonal >= left:
                current[asr_index] = diagonal
                trace[asr_index] = 0
            elif up >= left:
                current[asr_index] = up
                trace[asr_index] = 1
            else:
                current[asr_index] = left
                trace[asr_index] = 2
        traces.append(trace)
        previous = current

    end_asr_index = max(range(width), key=previous.__getitem__)
    mapping = [None] * len(canonical_words)
    canonical_index = len(canonical_words)
    asr_index = end_asr_index

    while canonical_index > 0:
        direction = traces[canonical_index][asr_index]
        if direction == 0:
            kind, similarity, _ = similarity_kind(
                canonical_norm[canonical_index - 1], asr_norm[asr_index - 1]
            )
            mapping[canonical_index - 1] = {
                "asrIndex": asr_index - 1,
                "kind": kind,
                "similarity": similarity,
            }
            canonical_index -= 1
            asr_index -= 1
        elif direction == 1:
            canonical_index -= 1
        else:
            asr_index -= 1

    mapped_indices = [item["asrIndex"] for item in mapping if item is not None]
    return mapping, min(mapped_indices), max(mapped_indices), previous[end_asr_index]


def add_inferred_times(aligned_words):
    timed_indices = [index for index, word in enumerate(aligned_words) if word.get("startMs") is not None]
    if not timed_indices:
        raise RuntimeError("Alignment produced no timed canonical words")

    for index, word in enumerate(aligned_words):
        if word.get("startMs") is not None:
            continue
        previous_indices = [value for value in timed_indices if value < index]
        next_indices = [value for value in timed_indices if value > index]
        previous_index = previous_indices[-1] if previous_indices else None
        next_index = next_indices[0] if next_indices else None

        if previous_index is not None and next_index is not None:
            gap_count = next_index - previous_index
            available_start = aligned_words[previous_index]["endMs"]
            available_end = aligned_words[next_index]["startMs"]
            slot = max(40, (available_end - available_start) / gap_count)
            offset = index - previous_index - 1
            start_ms = round(available_start + slot * offset)
            end_ms = round(min(available_end, start_ms + slot * 0.85))
        elif previous_index is not None:
            start_ms = aligned_words[previous_index]["endMs"] + 40 * (index - previous_index - 1)
            end_ms = start_ms + 180
        else:
            end_ms = aligned_words[next_index]["startMs"] - 40 * (next_index - index - 1)
            start_ms = max(0, end_ms - 180)

        word["startMs"] = int(start_ms)
        word["endMs"] = int(max(start_ms + 20, end_ms))
        word["matchKind"] = "inferred"
        word["similarity"] = 0.0
        word["asrProbability"] = None


def main() -> None:
    parser = argparse.ArgumentParser(description="Align canonical book text with ASR word timestamps.")
    parser.add_argument("package_dir", type=Path)
    args = parser.parse_args()

    package_dir = args.package_dir.resolve()
    work_dir = package_dir / "work"
    dist_dir = package_dir / "dist"
    cues_draft = read_json(work_dir / "cues.draft.json")
    asr_payload = read_json(work_dir / "asr-words.json")
    asr_words = [word for word in asr_payload["words"] if normalize(word["surface"])]

    canonical_words = []
    for cue_index, cue in enumerate(cues_draft):
        for token_index, token in enumerate(cue["tokens"]):
            if token["kind"] == "word":
                canonical_words.append({
                    "cueIndex": cue_index,
                    "tokenIndex": token_index,
                    "cueId": cue["id"],
                    "tokenId": token["id"],
                    "surface": token["surface"],
                })

    mapping, first_asr_index, last_asr_index, alignment_score = align_words(canonical_words, asr_words)
    aligned_words = []
    for canonical_index, canonical in enumerate(canonical_words):
        match = mapping[canonical_index]
        aligned = dict(canonical)
        if match is None:
            aligned.update({
                "startMs": None,
                "endMs": None,
                "matchKind": "inferred",
                "similarity": 0.0,
                "asrProbability": None,
                "asrSurface": None,
                "asrIndex": None,
            })
        else:
            asr_word = asr_words[match["asrIndex"]]
            aligned.update({
                "startMs": asr_word["startMs"],
                "endMs": max(asr_word["startMs"] + 20, asr_word["endMs"]),
                "matchKind": match["kind"],
                "similarity": match["similarity"],
                "asrProbability": asr_word["probability"],
                "asrSurface": asr_word["surface"].strip(),
                "asrIndex": match["asrIndex"],
            })
        aligned_words.append(aligned)

    add_inferred_times(aligned_words)
    by_token_id = {word["tokenId"]: word for word in aligned_words}

    all_content_cues = []
    omitted_cues = []
    for cue in cues_draft:
        output_tokens = []
        cue_words = []
        for token in cue["tokens"]:
            output_token = dict(token)
            if token["kind"] == "word":
                alignment = by_token_id[token["id"]]
                output_token.update({
                    "startMs": alignment["startMs"],
                    "endMs": alignment["endMs"],
                    "alignment": alignment["matchKind"],
                    "alignmentConfidence": round(
                        alignment["similarity"] * (alignment["asrProbability"] or 0), 4
                    ),
                })
                cue_words.append(alignment)
            output_tokens.append(output_token)

        output_cue = {
            "id": cue["id"],
            "kind": "content",
            "startMs": cue_words[0]["startMs"],
            "endMs": max(cue_words[0]["startMs"] + 20, cue_words[-1]["endMs"]),
            "text": cue["text"],
            "translation": cue.get("translation"),
            "reviewStatus": "needs_review",
            "tokens": output_tokens,
        }
        all_content_cues.append(output_cue)
        anchor_count = sum(word["matchKind"] != "inferred" for word in cue_words)
        anchor_ratio = anchor_count / len(cue_words)
        if anchor_ratio < 0.4:
            omitted_cues.append({
                "cueId": cue["id"],
                "text": cue["text"],
                "anchorRatio": round(anchor_ratio, 4),
                "reason": "The electronic-text sentence is not substantially present in this recording.",
            })

    omitted_ids = {cue["cueId"] for cue in omitted_cues}
    content_cues = [cue for cue in all_content_cues if cue["id"] not in omitted_ids]

    for index, cue in enumerate(content_cues[:-1]):
        next_start = content_cues[index + 1]["startMs"]
        cue["endMs"] = min(max(cue["endMs"], cue["startMs"] + 300), max(cue["endMs"], next_start - 40))
        cue["endMs"] = min(cue["endMs"], next_start)

    intro_words = asr_words[:first_asr_index]
    outro_words = asr_words[last_asr_index + 1:]
    intro_text = "".join(word["surface"] for word in intro_words).strip()
    outro_text = "".join(word["surface"] for word in outro_words).strip()
    intro_end = max(0, content_cues[0]["startMs"] - 100)
    outro_start = min(asr_payload["durationMs"], content_cues[-1]["endMs"] + 100)

    final_cues = [{
        "id": "intro-0001",
        "kind": "intro",
        "startMs": 0,
        "endMs": intro_end,
        "text": intro_text,
        "translation": None,
        "reviewStatus": "needs_review",
        "tokens": [],
    }]
    final_cues.extend(content_cues)
    if outro_text:
        final_cues.append({
            "id": "outro-0001",
            "kind": "outro",
            "startMs": outro_start,
            "endMs": asr_payload["durationMs"],
            "text": outro_text,
            "translation": None,
            "reviewStatus": "needs_review",
            "tokens": [],
        })

    counts = {"exact": 0, "fuzzy": 0, "substitution": 0, "inferred": 0}
    low_confidence = []
    for word in aligned_words:
        counts[word["matchKind"]] += 1
        confidence = word["similarity"] * (word["asrProbability"] or 0)
        if word["matchKind"] in {"substitution", "inferred"} or confidence < 0.45:
            low_confidence.append({
                "cueId": word["cueId"],
                "tokenId": word["tokenId"],
                "canonical": word["surface"],
                "recognized": word.get("asrSurface"),
                "startMs": word["startMs"],
                "endMs": word["endMs"],
                "matchKind": word["matchKind"],
                "confidence": round(confidence, 4),
            })

    recognized_count = counts["exact"] + counts["fuzzy"]
    coverage = recognized_count / len(aligned_words)
    monotonic = all(
        cue["startMs"] < cue["endMs"] and (
            index == 0 or cue["startMs"] >= final_cues[index - 1]["startMs"]
        )
        for index, cue in enumerate(final_cues)
    )

    alignment_report = {
        "schemaVersion": 1,
        "pieceId": "peter-rabbit-01",
        "status": "needs_review",
        "engine": "faster-whisper-base.en-plus-known-text-dp",
        "score": round(alignment_score, 3),
        "canonicalWords": len(canonical_words),
        "asrWords": len(asr_words),
        "firstContentAsrIndex": first_asr_index,
        "lastContentAsrIndex": last_asr_index,
        "counts": counts,
        "recognizedCoverage": round(coverage, 6),
        "lowConfidenceCount": len(low_confidence),
        "omittedCanonicalCues": omitted_cues,
        "publishedContentCues": len(content_cues),
        "cueCount": len(final_cues),
        "cueTimingComplete": True,
        "timingMonotonic": monotonic,
        "introText": intro_text,
        "outroText": outro_text,
    }

    write_json(work_dir / "alignment.json", alignment_report)
    write_json(work_dir / "unmatched.json", {
        "schemaVersion": 1,
        "pieceId": "peter-rabbit-01",
        "status": "needs_review",
        "items": low_confidence,
    })
    write_json(work_dir / "cues.aligned.json", final_cues)
    write_json(dist_dir / "cues.json", final_cues)

    qa_path = dist_dir / "qa-report.json"
    qa_report = read_json(qa_path)
    qa_report["checks"]["cueTimingComplete"] = True
    qa_report["checks"]["introOutroSeparated"] = True
    qa_report["checks"]["subtitleReviewComplete"] = False
    qa_report["alignment"] = {
        "engine": alignment_report["engine"],
        "recognizedCoverage": alignment_report["recognizedCoverage"],
        "lowConfidenceCount": alignment_report["lowConfidenceCount"],
        "omittedCanonicalCueCount": len(omitted_cues),
        "timingMonotonic": alignment_report["timingMonotonic"],
    }
    qa_report["counts"]["cues"] = len(final_cues)
    qa_report["blockers"] = [
        f"{len(low_confidence)} low-confidence word alignments require review.",
        f"{len(omitted_cues)} electronic-text sentences are not substantially present in the recording.",
        "Vocabulary entries require POS, sense, phonetics and definitions.",
        "Human subtitle and vocabulary review is pending.",
        "Rights need release-jurisdiction review.",
    ]
    write_json(qa_path, qa_report)

    manifest_path = dist_dir / "manifest.json"
    publish_manifest = read_json(manifest_path)
    publish_manifest["artifacts"] = {
        "cues": "dist/cues.json",
        "vocabDraft": "work/vocab.draft.json",
        "qaReport": "dist/qa-report.json",
        "reviewDecisions": "review/review-decisions.json",
        "corrections": "review/corrections.json",
    }
    publish_manifest["counts"]["cues"] = len(final_cues)
    publish_manifest["blockers"] = qa_report["blockers"]
    write_json(manifest_path, publish_manifest)

    print(json.dumps(alignment_report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
