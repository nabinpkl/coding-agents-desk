#!/usr/bin/env python3
"""Reproduce a pinned pronunciation-scoring candidate on macOS.

This benchmark deliberately validates the public GOPT scoring checkpoint and
its official SpeechOcean762 features separately from Agent Desk's raw-audio
feature extractor. Passing this benchmark is not authority to enable the app's
learner-facing grade.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
from typing import Any
from urllib.request import urlopen
import zipfile


GOPT_REPOSITORY = "https://github.com/YuanGongND/gopt.git"
GOPT_COMMIT = "bed909daf8eca035095871e51642525acc5b9b55"
GOPT_LICENSE = "BSD-3-Clause"
GOPT_LICENSE_SHA256 = (
    "d501f3b58c954ae35e9dac25422a1a4e1dc8a24be3de27c8feedfe383726e52c"
)
GOPT_MODEL_SOURCE_SHA256 = (
    "e63a178f5d32221ebc1233a4fe32dc12a092f804360b1782a6159d3185b3be34"
)
GOPT_CHECKPOINT_SHA256 = (
    "ab07451e51648f9d2455505a51055b20ac4ad7921d771ccc5170ff486a826259"
)
GOPT_DATA_URL = (
    "https://www.dropbox.com/s/zc6o1d8rqq28vci/data.zip?dl=1"
)
GOPT_DATA_SHA256 = (
    "67afce3591f00db674de28e9ad149dd9cd2b89efa7832da8762b02aed33d7146"
)
GOPT_DATA_FILES = (
    "te_feat.npy",
    "te_label_phn.npy",
)
GOPT_DATA_FILE_SHA256 = {
    "te_feat.npy": (
        "a80cbc7a2795b3de258186e87cbcc32608739cec74b525d725574dfa0210da7d"
    ),
    "te_label_phn.npy": (
        "c02e511d728928f4963621bc2b949d6fc894e39fb51f47a90ef877a30dbddda3"
    ),
}
GOPT_FEATURE_DIMENSION = 84
GOPT_FEATURE_EXTRACTOR = "Kaldi LibriSpeech TDNN GOP"
GOPT_NORMALIZATION_MEAN = 3.203
GOPT_NORMALIZATION_STD = 4.045
GOPT_PUBLISHED_PHONE_PEARSON = 0.616
MINIMUM_PHONE_PEARSON = 0.50
MINIMUM_PHONE_SPEARMAN = 0.50
MAXIMUM_PHONE_MSE = 0.35
CURRENT_CALIBRATION_CANDIDATES = (
    "alignedPosteriorMargin",
    "alignedLogitMargin",
    "alignmentFreeSubstitutionMargin",
    "alignmentFreeSubstitutionDeletionMargin",
)


class BenchmarkError(RuntimeError):
    """Raised when pinned benchmark provenance or results are invalid."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_hash(path: Path, expected: str, label: str) -> None:
    actual = sha256(path)
    if actual != expected:
        raise BenchmarkError(
            f"{label} SHA-256 mismatch: expected {expected}, got {actual}"
        )


def run(command: list[str], *, cwd: Path | None = None) -> str:
    completed = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise BenchmarkError(
            f"{' '.join(command)} failed with {completed.returncode}: {detail}"
        )
    return completed.stdout.strip()


def prepare_repository(cache_root: Path, *, offline: bool) -> Path:
    repository = cache_root / "gopt"
    if not repository.exists():
        if offline:
            raise BenchmarkError(
                f"Offline benchmark is missing pinned GOPT source at {repository}"
            )
        repository.mkdir(parents=True)
        run(["git", "init", "--quiet"], cwd=repository)
        run(["git", "remote", "add", "origin", GOPT_REPOSITORY], cwd=repository)
        run(
            [
                "git",
                "fetch",
                "--quiet",
                "--depth",
                "1",
                "origin",
                GOPT_COMMIT,
            ],
            cwd=repository,
        )
        run(
            ["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"],
            cwd=repository,
        )

    actual_commit = run(["git", "rev-parse", "HEAD"], cwd=repository)
    if actual_commit != GOPT_COMMIT:
        raise BenchmarkError(
            f"GOPT source revision mismatch: expected {GOPT_COMMIT}, "
            f"got {actual_commit}"
        )

    require_hash(
        repository / "LICENSE",
        GOPT_LICENSE_SHA256,
        "GOPT license",
    )
    require_hash(
        repository / "src" / "models" / "gopt.py",
        GOPT_MODEL_SOURCE_SHA256,
        "GOPT model source",
    )
    require_hash(
        repository
        / "pretrained_models"
        / "gopt_librispeech"
        / "best_audio_model.pth",
        GOPT_CHECKPOINT_SHA256,
        "GOPT checkpoint",
    )
    return repository


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    with urlopen(url, timeout=120) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    os.replace(temporary, destination)


def extract_gopt_test_data(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as package:
        for filename in GOPT_DATA_FILES:
            member = f"seq_data_librispeech/{filename}"
            try:
                source = package.open(member)
            except KeyError as error:
                raise BenchmarkError(
                    f"GOPT data archive is missing {member}"
                ) from error
            output = destination / filename
            temporary = output.with_suffix(output.suffix + ".part")
            with source, temporary.open("wb") as handle:
                shutil.copyfileobj(source, handle, length=1024 * 1024)
            os.replace(temporary, output)


def prepare_test_data(cache_root: Path, *, offline: bool) -> Path:
    data_root = cache_root / "seq_data_librispeech"
    if all((data_root / filename).is_file() for filename in GOPT_DATA_FILES):
        for filename, expected in GOPT_DATA_FILE_SHA256.items():
            require_hash(
                data_root / filename,
                expected,
                f"GOPT extracted {filename}",
            )
        return data_root

    archive = cache_root / "gopt-data.zip"
    if not archive.exists():
        if offline:
            raise BenchmarkError(
                f"Offline benchmark is missing GOPT data at {archive}"
            )
        download(GOPT_DATA_URL, archive)
    require_hash(archive, GOPT_DATA_SHA256, "GOPT feature archive")
    extract_gopt_test_data(archive, data_root)
    for filename, expected in GOPT_DATA_FILE_SHA256.items():
        require_hash(
            data_root / filename,
            expected,
            f"GOPT extracted {filename}",
        )
    return data_root


def load_gopt_class(repository: Path):
    source = repository / "src" / "models" / "gopt.py"
    spec = importlib.util.spec_from_file_location("pinned_gopt_model", source)
    if spec is None or spec.loader is None:
        raise BenchmarkError(f"Could not load pinned GOPT model from {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.GOPT


def score_metrics(
    predictions: Any,
    targets: Any,
) -> dict[str, float]:
    import numpy as np
    from scipy import stats

    predicted = np.asarray(predictions, dtype=np.float64)
    expected = np.asarray(targets, dtype=np.float64)
    if predicted.shape != expected.shape or predicted.size < 2:
        raise BenchmarkError("Metric inputs must be matching non-trivial arrays")
    return {
        "phoneMSE": float(np.mean((predicted - expected) ** 2)),
        "phonePearson": float(np.corrcoef(predicted, expected)[0, 1]),
        "phoneSpearman": float(stats.spearmanr(predicted, expected).statistic),
    }


def compatibility_report() -> dict[str, Any]:
    return {
        "compatible": False,
        "candidateFeatureDimension": GOPT_FEATURE_DIMENSION,
        "candidateFeatureExtractor": GOPT_FEATURE_EXTRACTOR,
        "currentCalibrationCandidateDimension": len(
            CURRENT_CALIBRATION_CANDIDATES
        ),
        "currentCalibrationCandidateFeatures": list(
            CURRENT_CALIBRATION_CANDIDATES
        ),
        "reason": (
            "The validated checkpoint consumes a full 84-value Kaldi GOP "
            "vector per phone. Agent Desk's current calibration surface has "
            "four scalar CTC candidate margins, so the checkpoint cannot "
            "score current app evidence."
        ),
    }


def passes_scorer_gate(metrics: dict[str, float]) -> bool:
    return bool(
        metrics["phonePearson"] >= MINIMUM_PHONE_PEARSON
        and metrics["phoneSpearman"] >= MINIMUM_PHONE_SPEARMAN
        and metrics["phoneMSE"] <= MAXIMUM_PHONE_MSE
    )


def evaluate(
    repository: Path,
    data_root: Path,
    *,
    device_name: str,
    batch_size: int,
) -> dict[str, Any]:
    import numpy as np
    import torch

    if device_name == "mps" and not torch.backends.mps.is_available():
        raise BenchmarkError("MPS was requested but is not available")
    device = torch.device(device_name)

    features = np.load(data_root / "te_feat.npy", mmap_mode="r")
    labels = np.load(data_root / "te_label_phn.npy", mmap_mode="r")
    if features.shape != (2500, 50, GOPT_FEATURE_DIMENSION):
        raise BenchmarkError(f"Unexpected GOPT feature shape: {features.shape}")
    if labels.shape != (2500, 50, 2):
        raise BenchmarkError(f"Unexpected GOPT label shape: {labels.shape}")

    model_class = load_gopt_class(repository)
    model = model_class(
        embed_dim=24,
        num_heads=1,
        depth=3,
        input_dim=GOPT_FEATURE_DIMENSION,
    )
    checkpoint = (
        repository
        / "pretrained_models"
        / "gopt_librispeech"
        / "best_audio_model.pth"
    )
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(
        {key.removeprefix("module."): value for key, value in state.items()},
        strict=True,
    )
    model.to(device)
    model.eval()

    predictions = []
    targets = []
    started = time.perf_counter()
    with torch.inference_mode():
        for lower in range(0, features.shape[0], batch_size):
            upper = lower + batch_size
            raw = torch.from_numpy(
                np.asarray(features[lower:upper]).copy()
            ).float()
            valid_features = raw[:, :, 0] != 0
            normalized = torch.zeros_like(raw)
            normalized[valid_features] = (
                raw[valid_features] - GOPT_NORMALIZATION_MEAN
            ) / GOPT_NORMALIZATION_STD
            phones = torch.from_numpy(
                np.asarray(labels[lower:upper, :, 0]).copy()
            ).float()
            grades = torch.from_numpy(
                np.asarray(labels[lower:upper, :, 1]).copy()
            ).float()
            normalized = normalized.to(device)
            phones = phones.to(device)
            *_, phone_scores, _, _, _ = model(normalized, phones)
            valid_grades = grades >= 0
            predictions.append(
                phone_scores.squeeze(-1).cpu()[valid_grades].numpy()
            )
            targets.append(grades[valid_grades].numpy())

    predicted = np.concatenate(predictions)
    expected = np.concatenate(targets)
    metrics = score_metrics(predicted, expected)
    metrics.update(
        {
            "elapsedSeconds": time.perf_counter() - started,
            "utteranceCount": int(features.shape[0]),
            "phoneCount": int(expected.size),
            "predictionMinimum": float(predicted.min()),
            "predictionMaximum": float(predicted.max()),
        }
    )
    metrics["passesScorerGate"] = passes_scorer_gate(metrics)
    metrics["reproducesPublishedPearson"] = bool(
        abs(
            metrics["phonePearson"] - GOPT_PUBLISHED_PHONE_PEARSON
        ) <= 0.01
    )

    compatibility = compatibility_report()
    return {
        "schemaVersion": 1,
        "candidate": {
            "identifier": "GOPT-LibriSpeech",
            "repository": GOPT_REPOSITORY,
            "commit": GOPT_COMMIT,
            "license": GOPT_LICENSE,
            "checkpointSHA256": GOPT_CHECKPOINT_SHA256,
            "featureArchiveSHA256": GOPT_DATA_SHA256,
            "publishedPhonePearson": GOPT_PUBLISHED_PHONE_PEARSON,
        },
        "environment": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "torch": torch.__version__,
            "device": str(device),
            "mpsAvailable": torch.backends.mps.is_available(),
        },
        "validation": {
            "corpus": "SpeechOcean762",
            "split": "official test",
            "requiredPhonePearson": MINIMUM_PHONE_PEARSON,
            "requiredPhoneSpearman": MINIMUM_PHONE_SPEARMAN,
            "maximumPhoneMSE": MAXIMUM_PHONE_MSE,
            **metrics,
        },
        "currentPipelineCompatibility": compatibility,
        "decision": {
            "checkpointReproductionValidated": metrics[
                "reproducesPublishedPearson"
            ],
            "scorerGatePassed": metrics["passesScorerGate"],
            "rawAudioReplacementValidated": False,
            "appGradeEnableAuthorized": False,
            "reason": (
                "The checkpoint reproduces its published Pearson result but "
                "fails Agent Desk's Spearman gate. Its required acoustic "
                "feature extractor is also absent from the Agent Desk "
                "raw-audio pipeline."
            ),
        },
    }


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=Path(".build/voice-pronunciation-model-benchmark"),
    )
    parser.add_argument(
        "--report-path",
        type=Path,
        default=None,
    )
    parser.add_argument(
        "--device",
        choices=("cpu", "mps"),
        default="cpu",
    )
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--offline", action="store_true")
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    if arguments.batch_size <= 0:
        raise BenchmarkError("Batch size must be positive")
    cache_root = arguments.cache_root.resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    repository = prepare_repository(cache_root, offline=arguments.offline)
    data_root = prepare_test_data(cache_root, offline=arguments.offline)
    report = evaluate(
        repository,
        data_root,
        device_name=arguments.device,
        batch_size=arguments.batch_size,
    )
    report_path = (
        arguments.report_path.resolve()
        if arguments.report_path
        else cache_root / "report.json"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = report_path.with_suffix(report_path.suffix + ".part")
    temporary.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, report_path)
    print(json.dumps(report, indent=2, sort_keys=True))
    if not report["validation"]["passesScorerGate"]:
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BenchmarkError, OSError, zipfile.BadZipFile) as error:
        print(f"voice-pronunciation-model-benchmark: {error}", file=sys.stderr)
        raise SystemExit(1)
