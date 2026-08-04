#!/usr/bin/env python3
"""Reproduce, evaluate, and gate the R131 per-phone calibration manifest."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import wave

import numpy as np

import voice_phone_calibration_lib as calibration


SPEECHOCEAN_URL = (
    "https://openslr.trmal.net/resources/101/speechocean762.tar.gz"
)
SPEECHOCEAN_SHA256 = (
    "876c34b828c2ebcc35ba2ff1ba5947d50e6b0162fc4a4af91db0942422b3bdd5"
)
SPEECHOCEAN_REVISION = "OpenSLR-SLR101-2021-02-02"
SPEECHOCEAN_LICENSE = "CC BY 4.0"
MODEL_WEIGHT_SHA256 = (
    "8c093d09a94c89898670734440b18432f3229e7a9e5174f1fe3c159898fa172c"
)
VOCABULARY_SHA256 = (
    "202ef6b52161221d96496b4d189ab009b5a7b066a0a277822d9190a196fc6f69"
)
SAMPLE_RATE = 16_000
SAMPLE_COUNT = 64_000
FRAME_COUNT = 199
BLANK_TOKEN_ID = 0
SPECIAL_TOKEN_IDS = {0, 1, 2, 3}
L2_SPEAKER_L1 = {
    "ABA": "Arabic",
    "SKA": "Arabic",
    "YBAA": "Arabic",
    "ZHAA": "Arabic",
    "BWC": "Mandarin",
    "LXC": "Mandarin",
    "NCC": "Mandarin",
    "TXHC": "Mandarin",
    "ASI": "Hindi",
    "RRBI": "Hindi",
    "SVBI": "Hindi",
    "TNI": "Hindi",
    "HJK": "Korean",
    "HKK": "Korean",
    "YDCK": "Korean",
    "YKWK": "Korean",
    "EBVS": "Spanish",
    "ERMS": "Spanish",
    "MBMPS": "Spanish",
    "NJS": "Spanish",
    "HQTV": "Vietnamese",
    "PNV": "Vietnamese",
    "THV": "Vietnamese",
    "TLV": "Vietnamese",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(
            json_compatible(value),
            allow_nan=False,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def json_compatible(value: object) -> object:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {
            str(key): json_compatible(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [json_compatible(item) for item in value]
    return value


def json_sha256(value: object) -> str:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise calibration.CalibrationError(
            "Training rows are not deterministic JSON"
        ) from error
    return hashlib.sha256(encoded).hexdigest()


def download(url: str, destination: Path, expected_sha256: str) -> None:
    if destination.exists() and sha256(destination) == expected_sha256:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".download")
    temporary.unlink(missing_ok=True)
    print(f"Downloading {url}", flush=True)
    try:
        with urllib.request.urlopen(url) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        actual = sha256(temporary)
        if actual != expected_sha256:
            raise calibration.CalibrationError(
                f"SpeechOcean762 SHA-256 mismatch: expected "
                f"{expected_sha256}, got {actual}"
            )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def safe_extract(archive: Path, destination: Path) -> None:
    marker = destination / ".extracted-sha256"
    archive_hash = sha256(archive)
    if marker.exists() and marker.read_text(encoding="utf-8").strip() == archive_hash:
        return
    temporary = Path(
        tempfile.mkdtemp(
            prefix="speechocean-extract-",
            dir=destination.parent,
        )
    )
    try:
        with tarfile.open(archive, "r:gz") as handle:
            root = temporary.resolve()
            for member in handle.getmembers():
                target = (temporary / member.name).resolve()
                if root not in target.parents and target != root:
                    raise calibration.CalibrationError(
                        f"Archive member escapes extraction root: {member.name}"
                    )
                if member.issym() or member.islnk():
                    raise calibration.CalibrationError(
                        f"Archive links are not accepted: {member.name}"
                    )
            handle.extractall(temporary, filter="data")
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(temporary, destination)
        marker.write_text(archive_hash + "\n", encoding="utf-8")
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def corpus_root(extracted: Path) -> Path:
    matches = list(extracted.rglob("scores.json"))
    if len(matches) != 1:
        raise calibration.CalibrationError(
            f"Expected one SpeechOcean scores.json, found {len(matches)}"
        )
    score_parent = matches[0].parent
    candidates = (score_parent, score_parent.parent)
    for candidate in candidates:
        if (candidate / "train" / "utt2spk").is_file() and (
            candidate / "test" / "utt2spk"
        ).is_file():
            return candidate
    raise calibration.CalibrationError(
        "SpeechOcean scores and split metadata do not share a corpus root"
    )


def scores_path(root: Path) -> Path:
    candidates = (root / "scores.json", root / "resource" / "scores.json")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise calibration.CalibrationError("SpeechOcean scores.json is missing")


def load_mapping(repo_root: Path) -> dict[str, str]:
    path = (
        repo_root
        / "voice-assets"
        / "arpabet-model-phone-map.json"
    )
    document = json.loads(path.read_text(encoding="utf-8"))
    if (
        document.get("schemaVersion") != 1
        or document.get("sourceRevision")
        != "74790861f652b15e4ac49015a90074ad62a27690"
        or not isinstance(document.get("mapping"), dict)
    ):
        raise calibration.CalibrationError("ARPABET mapping is malformed")
    return document["mapping"]


def load_vocabulary(repo_root: Path) -> tuple[list[str], dict[str, int]]:
    path = repo_root / ".build" / "voice-assets" / "VoicePhoneVocabulary.json"
    if sha256(path) != VOCABULARY_SHA256:
        raise calibration.CalibrationError("Pinned phone vocabulary hash changed")
    vocabulary = json.loads(path.read_text(encoding="utf-8"))
    if len(vocabulary) != 392 or not all(
        isinstance(token, str) for token in vocabulary
    ):
        raise calibration.CalibrationError("Pinned vocabulary is malformed")
    by_token: dict[str, int] = {}
    for index, token in enumerate(vocabulary):
        by_token.setdefault(token, index)
    return vocabulary, by_token


def parse_kaldi_map(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        key, value = line.split(maxsplit=1)
        result[key] = value.strip()
    return result


def split_metadata(root: Path, split: str) -> dict[str, object]:
    directory = root / split
    utterance_to_speaker = parse_kaldi_map(directory / "utt2spk")
    speakers_to_age = parse_kaldi_map(directory / "spk2age")
    speakers_to_gender = parse_kaldi_map(directory / "spk2gender")
    wav_entries = parse_kaldi_map(directory / "wav.scp")
    if any(value.endswith("|") for value in wav_entries.values()):
        raise calibration.CalibrationError(
            "wav.scp command pipelines are not accepted"
        )
    speakers = set(utterance_to_speaker.values())
    return {
        "utteranceToSpeaker": utterance_to_speaker,
        "speakerToAge": speakers_to_age,
        "speakerToGender": speakers_to_gender,
        "wavEntries": wav_entries,
        "speakers": speakers,
    }


def resolve_wav(root: Path, value: str) -> Path:
    candidate = Path(value)
    candidates = [
        candidate,
        root / candidate,
        root / "WAVE" / candidate.name,
    ]
    if "WAVE/" in value:
        candidates.append(root / value[value.index("WAVE/") :])
    for path in candidates:
        if path.is_file():
            return path
    matches = list((root / "WAVE").rglob(candidate.name))
    if len(matches) == 1:
        return matches[0]
    raise calibration.CalibrationError(f"Cannot resolve WAV entry {value}")


def read_pcm16_wav(
    path: Path,
    *,
    allow_resample: bool = False,
) -> tuple[np.ndarray, float, float, float]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frame_count = handle.getnframes()
        payload = handle.readframes(frame_count)
    if channels != 1 or sample_width != 2:
        raise calibration.CalibrationError(
            f"{path} must be mono PCM16, got channels={channels} "
            f"sample-width={sample_width}"
        )
    samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768
    if sample_rate != SAMPLE_RATE:
        if not allow_resample:
            raise calibration.CalibrationError(
                f"{path} uses {sample_rate} Hz; expected {SAMPLE_RATE}"
            )
        from scipy.signal import resample_poly

        divisor = math.gcd(sample_rate, SAMPLE_RATE)
        samples = resample_poly(
            samples,
            SAMPLE_RATE // divisor,
            sample_rate // divisor,
        ).astype(np.float32)
    duration = len(samples) / SAMPLE_RATE
    peak = float(np.max(np.abs(samples))) if len(samples) else 0
    clipped_ratio = (
        float(np.mean(np.abs(samples) >= 0.999)) if len(samples) else 0
    )
    if len(samples) > SAMPLE_COUNT:
        raise calibration.CalibrationError(
            f"{path} is {duration:.3f}s, over the four-second contract"
        )
    padded = np.pad(samples, (0, SAMPLE_COUNT - len(samples)))
    return padded.astype(np.float32), duration, peak, clipped_ratio


def load_coreml_model(repo_root: Path):
    try:
        import coremltools as ct
    except ImportError as error:
        raise calibration.CalibrationError(
            "coremltools is missing; run the Just recipe that prepares the "
            "calibration environment"
        ) from error
    model_path = (
        repo_root / "client" / "AgentDeskClient" / "VoicePhoneModel.mlpackage"
    )
    if not model_path.exists():
        raise calibration.CalibrationError(
            "Pinned Core ML package is missing; run: just voice-phone-model"
        )
    return ct.models.MLModel(
        str(model_path),
        compute_units=ct.ComputeUnit.CPU_AND_NE,
    )


def predict_logits(model, samples: np.ndarray) -> np.ndarray:
    output = model.predict({"input_values": samples[np.newaxis, :]})
    logits = np.asarray(output["logits"], dtype=np.float32)
    if logits.shape != (1, FRAME_COUNT, 392):
        raise calibration.CalibrationError(
            f"Core ML output shape is {logits.shape}, expected (1, 199, 392)"
        )
    return logits[0]


def utterance_targets(
    score: dict[str, object],
    mapping: dict[str, str],
) -> tuple[list[str], list[float], list[str]]:
    arpabet: list[str] = []
    phones: list[str] = []
    grades: list[float] = []
    words = score.get("words")
    if not isinstance(words, list):
        raise calibration.CalibrationError("score record has no words")
    for word in words:
        if not isinstance(word, dict):
            raise calibration.CalibrationError("word score is malformed")
        symbols = word.get("phones")
        if isinstance(symbols, str):
            symbols = symbols.split()
        word_grades = word.get("phones-accuracy")
        if (
            not isinstance(symbols, list)
            or not isinstance(word_grades, list)
            or len(symbols) != len(word_grades)
        ):
            raise calibration.CalibrationError(
                "word phone labels and grades do not align"
            )
        for symbol, grade in zip(symbols, word_grades):
            if not isinstance(symbol, str) or symbol not in mapping:
                raise calibration.CalibrationError(
                    f"ARPABET symbol {symbol!r} is unmapped"
                )
            if not isinstance(grade, (int, float)):
                raise calibration.CalibrationError("phone grade is not numeric")
            arpabet.append(symbol)
            phones.append(mapping[symbol])
            grades.append(float(grade))
    return phones, grades, arpabet


def score_utterance(
    *,
    logits: np.ndarray,
    phones: list[str],
    grades: list[float],
    vocabulary: list[str],
    by_token: dict[str, int],
    assessment_token_ids: list[int],
    metadata: dict[str, object],
) -> list[dict[str, object]]:
    target_token_ids = [by_token[phone] for phone in phones]
    posteriors = calibration.log_posteriors(logits)
    _, ranges = calibration.viterbi_alignment(
        posteriors,
        target_token_ids,
        BLANK_TOKEN_ID,
    )
    rows = []
    for index, (phone, grade) in enumerate(zip(phones, grades)):
        if phone not in calibration.PRODUCT_PHONES:
            continue
        features = calibration.phone_score_features(
            logits=logits,
            posteriors=posteriors,
            target_token_ids=target_token_ids,
            target_index=index,
            aligned_range=ranges[index],
            assessment_token_ids=assessment_token_ids,
            blank_token_id=BLANK_TOKEN_ID,
            excluded_token_ids=SPECIAL_TOKEN_IDS,
            vocabulary=vocabulary,
        )
        rows.append(
            {
                **metadata,
                "phoneIndex": index,
                "phone": phone,
                "grade": grade,
                **features,
            }
        )
    return rows


def cached_rows(cache: Path) -> list[dict[str, object]]:
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(cache.glob("*.json"))
        for _ in [None]
    ]


def infer_speechocean_split(
    *,
    repo_root: Path,
    root: Path,
    split: str,
    output: Path,
    model,
    mapping: dict[str, str],
    vocabulary: list[str],
    by_token: dict[str, int],
    limit: int | None = None,
    shard_count: int = 1,
    shard_index: int = 0,
) -> tuple[list[dict[str, object]], Counter[str]]:
    metadata = split_metadata(root, split)
    scores = json.loads(scores_path(root).read_text(encoding="utf-8"))
    cache = output / "utterances" / split
    cache.mkdir(parents=True, exist_ok=True)
    exclusions: Counter[str] = Counter()
    assessment_token_ids = [
        by_token[phone] for phone in sorted(set(mapping.values()))
    ]
    utterances = sorted(metadata["utteranceToSpeaker"])
    if limit is not None:
        utterances = utterances[:limit]
    utterances = [
        utterance
        for index, utterance in enumerate(utterances)
        if index % shard_count == shard_index
    ]
    for sequence, utterance in enumerate(utterances, 1):
        destination = cache / f"{utterance}.json"
        if destination.exists():
            continue
        try:
            speaker = metadata["utteranceToSpeaker"][utterance]
            wav = resolve_wav(root, metadata["wavEntries"][utterance])
            samples, duration, peak, clipped_ratio = read_pcm16_wav(wav)
            phones, grades, _ = utterance_targets(scores[utterance], mapping)
            logits = predict_logits(model, samples)
            age = int(metadata["speakerToAge"][speaker])
            rows = score_utterance(
                logits=logits,
                phones=phones,
                grades=grades,
                vocabulary=vocabulary,
                by_token=by_token,
                assessment_token_ids=assessment_token_ids,
                metadata={
                    "split": split,
                    "utterance": utterance,
                    "speaker": speaker,
                    "age": age,
                    "ageGroup": "adult" if age >= 18 else "child",
                    "gender": metadata["speakerToGender"][speaker],
                    "durationSeconds": duration,
                    "peakAbsoluteSample": peak,
                    "clippedSampleRatio": clipped_ratio,
                },
            )
            write_json(destination, rows)
        except calibration.CalibrationError as error:
            write_json(
                destination,
                {
                    "excluded": True,
                    "utterance": utterance,
                    "reason": str(error),
                },
            )
        if sequence % 25 == 0:
            print(f"{split}: {sequence}/{len(utterances)}", flush=True)
    rows = []
    for value in cached_rows(cache):
        if isinstance(value, list):
            rows.extend(value)
        elif value.get("excluded"):
            exclusions[value["reason"].split(":", 1)[0]] += 1
    return rows, exclusions


def l2_phone_labels(text_grid_path: Path) -> tuple[list[str], list[int]]:
    try:
        import textgrid
    except ImportError as error:
        raise calibration.CalibrationError(
            "textgrid is missing from the calibration environment"
        ) from error
    grid = textgrid.TextGrid.fromFile(str(text_grid_path))
    try:
        tier = grid.getFirst("phones")
    except ValueError as error:
        raise calibration.CalibrationError(
            f"{text_grid_path} has no phones tier"
        ) from error
    canonical: list[str] = []
    correct: list[int] = []
    for interval in tier:
        mark = interval.mark.strip()
        if not mark or mark.lower() in {"sil", "sp", "spn"}:
            continue
        components = [component.strip() for component in mark.split(",")]
        if len(components) == 1:
            canonical.append(components[0])
            correct.append(1)
            continue
        if len(components) != 3:
            raise calibration.CalibrationError(
                f"unsupported L2-ARCTIC phone annotation {mark!r}"
            )
        canonical_phone, _, error_type = components
        if error_type == "a":
            continue
        if error_type not in {"s", "d"}:
            raise calibration.CalibrationError(
                f"unsupported L2-ARCTIC error type {error_type!r}"
            )
        canonical.append(canonical_phone)
        correct.append(0)
    if not canonical:
        raise calibration.CalibrationError(
            f"{text_grid_path} contains no canonical phones"
        )
    return canonical, correct


def infer_l2_arctic(
    *,
    repo_root: Path,
    l2_root: Path,
    output: Path,
    model,
    mapping: dict[str, str],
    vocabulary: list[str],
    by_token: dict[str, int],
) -> tuple[list[dict[str, object]], Counter[str]]:
    license_path = l2_root / "LICENSE"
    if not license_path.is_file() or "Attribution-NonCommercial" not in (
        license_path.read_text(encoding="utf-8", errors="replace")
    ):
        raise calibration.CalibrationError(
            "L2-ARCTIC root lacks its CC BY-NC license marker"
        )
    cache = output / "utterances" / "l2-arctic"
    cache.mkdir(parents=True, exist_ok=True)
    exclusions: Counter[str] = Counter()
    assessment_token_ids = [
        by_token[phone] for phone in sorted(set(mapping.values()))
    ]
    annotations = sorted(l2_root.glob("*/annotation/*.TextGrid"))
    if len(annotations) < 3_500:
        raise calibration.CalibrationError(
            f"L2-ARCTIC root has {len(annotations)} manual annotations; "
            "expected at least 3500"
        )
    for sequence, annotation in enumerate(annotations, 1):
        speaker = annotation.parents[1].name
        destination = cache / f"{speaker}-{annotation.stem}.json"
        if destination.exists():
            continue
        try:
            if speaker not in L2_SPEAKER_L1:
                raise calibration.CalibrationError(
                    f"unknown L2-ARCTIC speaker {speaker}"
                )
            wav = annotation.parents[1] / "wav" / f"{annotation.stem}.wav"
            samples, duration, peak, clipped_ratio = read_pcm16_wav(
                wav,
                allow_resample=True,
            )
            arpabet, correct = l2_phone_labels(annotation)
            unknown = [symbol for symbol in arpabet if symbol not in mapping]
            if unknown:
                raise calibration.CalibrationError(
                    f"unmapped L2-ARCTIC phone {unknown[0]!r}"
                )
            phones = [mapping[symbol] for symbol in arpabet]
            logits = predict_logits(model, samples)
            rows = score_utterance(
                logits=logits,
                phones=phones,
                grades=[2.0 if value else 0.0 for value in correct],
                vocabulary=vocabulary,
                by_token=by_token,
                assessment_token_ids=assessment_token_ids,
                metadata={
                    "split": "l2-arctic",
                    "utterance": annotation.stem,
                    "speaker": speaker,
                    "l1": L2_SPEAKER_L1[speaker],
                    "durationSeconds": duration,
                    "peakAbsoluteSample": peak,
                    "clippedSampleRatio": clipped_ratio,
                    "preprocessing": "PCM16-resample-poly-to-16k",
                },
            )
            correct_by_index = dict(enumerate(correct))
            for row in rows:
                row["correct"] = correct_by_index[int(row["phoneIndex"])]
            write_json(destination, rows)
        except calibration.CalibrationError as error:
            write_json(
                destination,
                {
                    "excluded": True,
                    "utterance": annotation.stem,
                    "speaker": speaker,
                    "reason": str(error),
                },
            )
        if sequence % 25 == 0:
            print(
                f"l2-arctic: {sequence}/{len(annotations)}",
                flush=True,
            )
    rows = []
    for value in cached_rows(cache):
        if isinstance(value, list):
            rows.extend(value)
        elif value.get("excluded"):
            exclusions[value["reason"].split(":", 1)[0]] += 1
    return rows, exclusions


def audit_corpus(root: Path) -> dict[str, object]:
    train = split_metadata(root, "train")
    test = split_metadata(root, "test")
    overlap = train["speakers"].intersection(test["speakers"])
    if overlap:
        raise calibration.CalibrationError(
            f"SpeechOcean speaker split overlaps: {sorted(overlap)}"
        )
    scores = json.loads(scores_path(root).read_text(encoding="utf-8"))
    train_ids = set(train["utteranceToSpeaker"])
    test_ids = set(test["utteranceToSpeaker"])
    if len(train_ids) != 2_500 or len(test_ids) != 2_500:
        raise calibration.CalibrationError(
            f"Expected 2500/2500 utterances, got "
            f"{len(train_ids)}/{len(test_ids)}"
        )
    if not train_ids.union(test_ids).issubset(scores):
        raise calibration.CalibrationError("scores.json is missing split IDs")
    return {
        "corpus": "SpeechOcean762",
        "revision": SPEECHOCEAN_REVISION,
        "license": SPEECHOCEAN_LICENSE,
        "trainUtterances": len(train_ids),
        "testUtterances": len(test_ids),
        "trainSpeakers": len(train["speakers"]),
        "testSpeakers": len(test["speakers"]),
        "speakerOverlap": [],
    }


def finite_gate(value: float, minimum: float | None = None, maximum: float | None = None) -> bool:
    return (
        math.isfinite(value)
        and (minimum is None or value >= minimum)
        and (maximum is None or value <= maximum)
    )


def evaluate_l2_rows(
    rows: list[dict[str, object]],
    candidate: str,
    knots: list[dict[str, float]],
) -> tuple[dict[str, object], bool]:
    from sklearn.metrics import recall_score, roc_auc_score

    if not rows:
        return {"available": False}, False
    values = [float(row[candidate]) for row in rows]
    labels = [int(row["correct"]) for row in rows]
    if len(set(labels)) != 2:
        raise calibration.CalibrationError("L2-ARCTIC rows need both labels")
    overall = float(roc_auc_score(labels, values))
    threshold_candidates = np.linspace(min(values), max(values), 2_000)
    threshold = min(
        threshold_candidates,
        key=lambda value: abs(
            calibration.predict_knots([value], knots)[0] - 1.5
        ),
    )
    by_l1: dict[str, dict[str, float | int]] = {}
    recalls = {}
    for l1 in sorted({str(row["l1"]) for row in rows}):
        selected = [row for row in rows if row["l1"] == l1]
        selected_labels = [int(row["correct"]) for row in selected]
        selected_values = [float(row[candidate]) for row in selected]
        group_auroc = (
            float(roc_auc_score(selected_labels, selected_values))
            if len(set(selected_labels)) == 2
            else math.nan
        )
        predictions = [int(value >= threshold) for value in selected_values]
        recall = float(
            recall_score(
                selected_labels,
                predictions,
                pos_label=0,
                zero_division=0,
            )
        )
        recalls[l1] = recall
        by_l1[l1] = {
            "count": len(selected),
            "auroc": group_auroc,
            "errorRecall": recall,
        }
    worst_l1 = min(float(value["auroc"]) for value in by_l1.values())
    mandarin = recalls.get("Mandarin", math.nan)
    worst_gap = (
        max(0.0, mandarin - min(recalls.values()))
        if math.isfinite(mandarin)
        else math.inf
    )
    report = {
        "available": True,
        "overallAUROC": overall,
        "worstL1AUROC": worst_l1,
        "worstRecallGap": worst_gap,
        "frozenRawMarginThreshold": float(threshold),
        "byL1": by_l1,
    }
    passed = overall >= 0.70 and worst_l1 >= 0.55 and worst_gap <= 0.20
    return report, passed


def freeze_training_selection(
    train_rows: list[dict[str, object]],
) -> dict[str, object]:
    if not train_rows:
        raise calibration.CalibrationError(
            "Training split produced no retained product-phone rows"
        )
    candidate_reports = {
        candidate: calibration.grouped_cross_validation(train_rows, candidate)
        for candidate in calibration.CANDIDATES
    }
    selected = calibration.choose_candidate(candidate_reports)
    knots = calibration.fit_isotonic(
        [float(row[selected]) for row in train_rows],
        [float(row["grade"]) for row in train_rows],
    )
    return {
        "schemaVersion": 1,
        "featureVersion": calibration.FEATURE_VERSION,
        "candidateTrainingFoldMetrics": candidate_reports,
        "selectedCandidate": selected,
        "globalKnots": knots,
        "trainingRowCount": len(train_rows),
        "trainingRowsSHA256": json_sha256(train_rows),
        "trainingSpeakers": len({row["speaker"] for row in train_rows}),
        "sourceRevision": SPEECHOCEAN_REVISION,
        "modelWeightSHA256": MODEL_WEIGHT_SHA256,
        "vocabularySHA256": VOCABULARY_SHA256,
        "testLabelsOpened": False,
    }


def validate_training_selection(
    selection: dict[str, object],
    train_rows: list[dict[str, object]],
) -> None:
    selected_candidate = selection.get("selectedCandidate")
    knots = selection.get("globalKnots")
    if (
        selection.get("schemaVersion") != 1
        or selection.get("featureVersion") != calibration.FEATURE_VERSION
        or selection.get("testLabelsOpened") is not False
        or selection.get("trainingRowCount") != len(train_rows)
        or selection.get("trainingRowsSHA256") != json_sha256(train_rows)
        or selection.get("sourceRevision") != SPEECHOCEAN_REVISION
        or selection.get("modelWeightSHA256") != MODEL_WEIGHT_SHA256
        or selection.get("vocabularySHA256") != VOCABULARY_SHA256
        or selected_candidate not in calibration.CANDIDATES
        or not isinstance(knots, list)
        or len(knots) < 2
    ):
        raise calibration.CalibrationError(
            "Frozen training selection is missing or stale"
        )
    previous_margin = -math.inf
    previous_grade = -math.inf
    for knot in knots:
        if not isinstance(knot, dict):
            raise calibration.CalibrationError(
                "Frozen training selection has malformed calibration knots"
            )
        margin = knot.get("margin")
        grade = knot.get("expectedGrade")
        if (
            not isinstance(margin, (int, float))
            or not isinstance(grade, (int, float))
            or not math.isfinite(float(margin))
            or not math.isfinite(float(grade))
            or float(margin) <= previous_margin
            or float(grade) < previous_grade
            or not 0 <= float(grade) <= 2
        ):
            raise calibration.CalibrationError(
                "Frozen training selection has malformed calibration knots"
            )
        previous_margin = float(margin)
        previous_grade = float(grade)


def build_report_and_manifest(
    *,
    train_rows: list[dict[str, object]],
    test_rows: list[dict[str, object]],
    source_sha256: str,
    l2_rows: list[dict[str, object]],
    selection: dict[str, object],
) -> tuple[dict[str, object], dict[str, object]]:
    if not train_rows or not test_rows:
        raise calibration.CalibrationError(
            "Both SpeechOcean splits need retained phone rows"
        )
    validate_training_selection(selection, train_rows)
    candidate_reports = selection["candidateTrainingFoldMetrics"]
    selected = selection["selectedCandidate"]
    knots = selection["globalKnots"]
    test_values = [float(row[selected]) for row in test_rows]
    test_grades = [float(row["grade"]) for row in test_rows]
    test_predictions = calibration.predict_knots(test_values, knots)
    test_summary = calibration.metric_summary(
        test_values,
        test_grades,
        test_predictions,
    )
    bootstrap = calibration.bootstrap_pearson_lower_bound(
        test_rows,
        selected,
    )
    support = calibration.phone_support(
        train_rows,
        test_rows,
        selected,
        knots,
    )
    group_reports = {
        key: calibration.report_groups(test_rows, selected, knots, key)
        for key in ("phone", "ageGroup", "gender")
    }
    l2_report, l2_passed = evaluate_l2_rows(l2_rows, selected, knots)
    speech_ocean_passed = (
        finite_gate(
            float(test_summary["pearsonCorrelation"]),
            minimum=0.50,
        )
        and finite_gate(
            float(test_summary["spearmanCorrelation"]),
            minimum=0.50,
        )
        and finite_gate(
            float(test_summary["meanAbsoluteError"]),
            maximum=0.35,
        )
        and finite_gate(float(test_summary["auroc"]), minimum=0.80)
        and finite_gate(
            float(test_summary["calibrationError"]),
            maximum=0.10,
        )
        and finite_gate(bootstrap, minimum=0.45)
        and {item["phone"] for item in support}
        == set(calibration.PRODUCT_PHONES)
    )
    display_enabled = speech_ocean_passed and l2_passed
    if display_enabled:
        disabled_reason = None
    elif not speech_ocean_passed:
        disabled_reason = (
            "SpeechOcean762 held-out metrics or product-phone support gates "
            "did not pass."
        )
    elif not l2_report.get("available"):
        disabled_reason = (
            "L2-ARCTIC cross-L1 robustness has not been evaluated from a "
            "user-licensed local corpus."
        )
    else:
        disabled_reason = "L2-ARCTIC cross-L1 robustness gates did not pass."

    validation = {
        "testPearsonCorrelation": test_summary["pearsonCorrelation"],
        "testSpearmanCorrelation": test_summary["spearmanCorrelation"],
        "testMeanAbsoluteError": test_summary["meanAbsoluteError"],
        "testAUROC": test_summary["auroc"],
        "testCalibrationError": test_summary["calibrationError"],
        "speakerBootstrapPearsonLowerBound": bootstrap,
        "l2ArcticOverallAUROC": l2_report.get("overallAUROC"),
        "l2ArcticWorstL1AUROC": l2_report.get("worstL1AUROC"),
        "l2ArcticWorstRecallGap": l2_report.get("worstRecallGap"),
    }
    manifest = {
        "schemaVersion": 1,
        "identifier": (
            f"speechocean762-{SPEECHOCEAN_REVISION.lower()}-"
            f"{calibration.FEATURE_VERSION}"
        ),
        "generatedAt": "2026-07-26T00:00:00Z",
        "displayEnabled": display_enabled,
        "disabledReason": disabled_reason,
        "sourceCorpus": "SpeechOcean762",
        "sourceRevision": SPEECHOCEAN_REVISION,
        "sourceSHA256": source_sha256,
        "sourceLicense": SPEECHOCEAN_LICENSE,
        "sourcePopulation": (
            "Mandarin-L1 English learners; adult and child speakers"
        ),
        "localeIdentifiers": ["en-US"],
        "featureVersion": calibration.FEATURE_VERSION,
        "selectedCandidate": selected,
        "modelWeightSHA256": MODEL_WEIGHT_SHA256,
        "vocabularySHA256": VOCABULARY_SHA256,
        "minimumEffectiveNonBlankFrameCount": 2,
        "maximumBlankFrameRatio": 0.95,
        "maximumClippedSampleRatio": 0.01,
        "maximumSourceDurationSeconds": 4.0,
        "needsAttentionUpperBound": 1.0,
        "closeUpperBound": 1.5,
        "mappings": (
            [{"phone": None, "knots": knots}] if display_enabled else []
        ),
        "supportedPhones": support if display_enabled else [],
        "validation": validation if display_enabled else None,
    }
    report = {
        "featureVersion": calibration.FEATURE_VERSION,
        "candidateTrainingFoldMetrics": candidate_reports,
        "selectedCandidate": selected,
        "speechOceanTest": test_summary,
        "speakerBootstrapPearsonLowerBound": bootstrap,
        "supportedPhones": support,
        "speechOceanPassed": speech_ocean_passed,
        "testGroups": group_reports,
        "l2Arctic": l2_report,
        "l2ArcticPassed": l2_passed,
        "displayEnabled": display_enabled,
        "disabledReason": disabled_reason,
    }
    return report, manifest


def load_l2_rows(path: Path | None) -> list[dict[str, object]]:
    if path is None:
        return []
    if not path.is_file():
        raise calibration.CalibrationError(
            f"L2-ARCTIC evaluation rows are missing: {path}"
        )
    text = path.read_text(encoding="utf-8")
    if text.lstrip().startswith("["):
        value = json.loads(text)
        if not isinstance(value, list):
            raise calibration.CalibrationError("L2 row file is not an array")
        return value
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=(
            "audit",
            "smoke",
            "infer-train",
            "infer-test",
            "infer-l2",
            "report",
            "run",
        ),
    )
    parser.add_argument(
        "--cache",
        default=".build/voice-phone-calibration",
    )
    parser.add_argument("--l2-rows")
    parser.add_argument("--l2-root")
    parser.add_argument("--limit", type=int, default=2)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument(
        "--manifest-output",
        default=(
            "client/AgentDeskClient/VoicePhoneCalibrationManifest.json"
        ),
    )
    args = parser.parse_args()
    if args.shard_count < 1:
        raise calibration.CalibrationError("shard count must be positive")
    if not 0 <= args.shard_index < args.shard_count:
        raise calibration.CalibrationError(
            "shard index must be within the shard count"
        )
    if args.shard_count > 1 and args.command != "infer-test":
        raise calibration.CalibrationError(
            "sharding is restricted to the frozen official test inference"
        )
    repo_root = Path(__file__).resolve().parents[1]
    cache = (repo_root / args.cache).resolve()
    try:
        cache.relative_to(repo_root)
    except ValueError as error:
        raise calibration.CalibrationError(
            "Calibration cache must stay inside the repository"
        ) from error
    archive = cache / "speechocean762.tar.gz"
    extracted = cache / "speechocean762"
    root: Path | None = None
    if args.command in (
        "audit",
        "smoke",
        "infer-train",
        "infer-test",
        "run",
    ):
        download(SPEECHOCEAN_URL, archive, SPEECHOCEAN_SHA256)
        safe_extract(archive, extracted)
        root = corpus_root(extracted)
        audit = audit_corpus(root)
        write_json(cache / "audit.json", audit)
        if args.command == "audit":
            print(json.dumps(audit, indent=2, sort_keys=True))
            return 0

    if args.command in (
        "smoke",
        "infer-train",
        "infer-test",
        "infer-l2",
        "run",
    ):
        mapping = load_mapping(repo_root)
        vocabulary, by_token = load_vocabulary(repo_root)
        missing = sorted(set(mapping.values()).difference(by_token))
        if missing:
            raise calibration.CalibrationError(
                f"Model vocabulary lacks mapped phones: {missing}"
            )
        model = load_coreml_model(repo_root)
        if args.command == "smoke":
            if args.limit < 1:
                raise calibration.CalibrationError(
                    "smoke limit must be positive"
                )
            if root is None:
                raise calibration.CalibrationError(
                    "SpeechOcean corpus was not prepared"
                )
            smoke_root = cache / "smoke"
            if smoke_root.exists():
                shutil.rmtree(smoke_root)
            rows, exclusions = infer_speechocean_split(
                repo_root=repo_root,
                root=root,
                split="train",
                output=smoke_root,
                model=model,
                mapping=mapping,
                vocabulary=vocabulary,
                by_token=by_token,
                limit=args.limit,
                shard_count=args.shard_count,
                shard_index=args.shard_index,
            )
            result = {
                "utteranceLimit": args.limit,
                "retainedPhoneRows": len(rows),
                "exclusions": exclusions,
                "featureVersion": calibration.FEATURE_VERSION,
            }
            write_json(smoke_root / "result.json", result)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0 if rows else 1
        if args.command == "infer-l2":
            if not args.l2_root:
                raise calibration.CalibrationError(
                    "infer-l2 requires --l2-root after the user accepts and "
                    "downloads the corpus license"
                )
            rows, exclusions = infer_l2_arctic(
                repo_root=repo_root,
                l2_root=(repo_root / args.l2_root).resolve(),
                output=cache,
                model=model,
                mapping=mapping,
                vocabulary=vocabulary,
                by_token=by_token,
            )
            write_json(cache / "l2-rows.json", rows)
            write_json(cache / "l2-exclusions.json", exclusions)
            return 0
        splits = (
            ("train", "test")
            if args.command == "run"
            else ("train",)
            if args.command == "infer-train"
            else ("test",)
        )
        if root is None:
            raise calibration.CalibrationError(
                "SpeechOcean corpus was not prepared"
            )
        for split in splits:
            if split == "test":
                selection_path = cache / "selection.json"
                training_rows_path = cache / "train-rows.json"
                if not selection_path.is_file() or not training_rows_path.is_file():
                    raise calibration.CalibrationError(
                        "Freeze the training candidate before opening test labels"
                    )
                validate_training_selection(
                    json.loads(selection_path.read_text(encoding="utf-8")),
                    json.loads(training_rows_path.read_text(encoding="utf-8")),
                )
            rows, exclusions = infer_speechocean_split(
                repo_root=repo_root,
                root=root,
                split=split,
                output=cache,
                model=model,
                mapping=mapping,
                vocabulary=vocabulary,
                by_token=by_token,
                shard_count=args.shard_count,
                shard_index=args.shard_index,
            )
            write_json(cache / f"{split}-rows.json", rows)
            write_json(cache / f"{split}-exclusions.json", exclusions)
            if split == "train":
                write_json(
                    cache / "selection.json",
                    freeze_training_selection(rows),
                )
        if args.command != "run":
            return 0

    train_rows = json.loads(
        (cache / "train-rows.json").read_text(encoding="utf-8")
    )
    test_rows = json.loads(
        (cache / "test-rows.json").read_text(encoding="utf-8")
    )
    report, manifest = build_report_and_manifest(
        train_rows=train_rows,
        test_rows=test_rows,
        source_sha256=sha256(archive),
        l2_rows=load_l2_rows(
            (repo_root / args.l2_rows).resolve()
            if args.l2_rows
            else (cache / "l2-rows.json")
            if (cache / "l2-rows.json").is_file()
            else None
        ),
        selection=json.loads(
            (cache / "selection.json").read_text(encoding="utf-8")
        ),
    )
    write_json(cache / "report.json", report)
    write_json((repo_root / args.manifest_output).resolve(), manifest)
    print(json.dumps(
        json_compatible(report),
        allow_nan=False,
        indent=2,
        sort_keys=True,
    ))
    return 0 if report["displayEnabled"] else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except calibration.CalibrationError as error:
        print(f"voice-phone-calibration: {error}", file=sys.stderr)
        raise SystemExit(1)
