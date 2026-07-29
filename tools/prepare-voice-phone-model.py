#!/usr/bin/env python3
"""Reproduce the pinned iOS 26 Core ML phoneme model used by R130."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request


MODEL_REPOSITORY = "alexmb522/wav2vec2-phoneme-coreml"
MODEL_REVISION = "834e7279c06dbf822061b0fd5b44ec122b4a0aae"
UPSTREAM_MODEL = "facebook/wav2vec2-lv-60-espeak-cv-ft"
UPSTREAM_LICENSE = "Apache-2.0"
SOURCE_FILES = {
    "Manifest.json": (
        "Wav2Vec2Phoneme.mlpackage/Manifest.json",
        "134c6f928574ae15f76788848ad45be3553cc315865175f601d22fd79d7696b5",
    ),
    "Data/com.apple.CoreML/model.mlmodel": (
        "Wav2Vec2Phoneme.mlpackage/Data/com.apple.CoreML/model.mlmodel",
        "7c75d0e89a54b4301f0b04cf0128a8c4d5782489ccb52bbde4ddd348c87a8183",
    ),
    "Data/com.apple.CoreML/weights/weight.bin": (
        "Wav2Vec2Phoneme.mlpackage/Data/com.apple.CoreML/weights/weight.bin",
        "28aff8c9a10343ec1fcf4b4ff798047a5a204ecaa6a2ec5908c783be6eb61323",
    ),
}
VOCABULARY_REMOTE_PATH = "vocab.json"
SOURCE_VOCABULARY_SHA256 = (
    "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0"
)
EXPECTED_OUTPUT_VOCABULARY_SHA256 = (
    "202ef6b52161221d96496b4d189ab009b5a7b066a0a277822d9190a196fc6f69"
)
CONVERSION_ID = "coremltools-9.0-lut4-kmeans-per-grouped-channel-16-ios26"
EXPECTED_OUTPUT_WEIGHT_SHA256 = (
    "8c093d09a94c89898670734440b18432f3229e7a9e5174f1fe3c159898fa172c"
)
EXPECTED_OUTPUT_SPECIFICATION_SHA256 = (
    "44629ea3d97747f6d80b8ebb906b5ddfabc301bdc6f565e5ed1bb625d46f34f4"
)
MAX_MODEL_BYTES = 220 * 1024 * 1024
REQUIRED_PHASE_ONE_PHONES = {
    "aɪ",
    "ɛ",
    "ɪ",
    "iː",
    "k",
    "l",
    "ŋ",
    "p",
    "s",
    "t",
    "v",
    "w",
    "ɹ",
    "θ",
    "ʃ",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(remote_path: str, destination: Path, expected_sha256: str) -> None:
    if destination.exists() and sha256(destination) == expected_sha256:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    url = (
        f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/"
        f"{MODEL_REVISION}/{remote_path}"
    )
    temporary = destination.with_suffix(destination.suffix + ".download")
    temporary.unlink(missing_ok=True)
    print(f"Downloading {url}", flush=True)
    try:
        with urllib.request.urlopen(url) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        actual = sha256(temporary)
        if actual != expected_sha256:
            raise RuntimeError(
                f"SHA-256 mismatch for {remote_path}: expected "
                f"{expected_sha256}, got {actual}"
            )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def package_size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def output_paths(repo_root: Path, output: str) -> tuple[Path, Path, Path]:
    output_root = (repo_root / output).resolve()
    try:
        output_root.relative_to(repo_root)
    except ValueError as error:
        raise RuntimeError("output must remain inside the repository") from error
    return (
        output_root / "VoicePhoneModel.mlpackage",
        output_root / "VoicePhoneModelManifest.json",
        output_root / "VoicePhoneVocabulary.json",
    )


def ordered_source_vocabulary(path: Path) -> list[str]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("Source vocabulary must be a token-to-ID object")
    if len(value) != 392:
        raise RuntimeError(
            f"Source vocabulary has {len(value)} entries; expected 392"
        )
    if any(
        not isinstance(token, str)
        or not isinstance(token_id, int)
        or isinstance(token_id, bool)
        for token, token_id in value.items()
    ):
        raise RuntimeError("Source vocabulary entries must map strings to integer IDs")
    token_ids = set(value.values())
    expected_token_ids = set(range(392))
    if token_ids != expected_token_ids:
        raise RuntimeError(
            "Source vocabulary IDs must be unique and contiguous from 0 through 391"
        )
    missing = REQUIRED_PHASE_ONE_PHONES.difference(value)
    if missing:
        raise RuntimeError(
            f"Source vocabulary is missing phase-one phones: {sorted(missing)}"
        )
    ordered = [""] * 392
    for token, token_id in value.items():
        ordered[token_id] = token
    return ordered


def validate_installed_vocabulary(path: Path) -> list[str]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list) or not all(
        isinstance(token, str) for token in value
    ):
        raise RuntimeError("Installed vocabulary must be an ID-ordered token array")
    if len(value) != 392:
        raise RuntimeError(
            f"Installed vocabulary has {len(value)} entries; expected 392"
        )
    missing = REQUIRED_PHASE_ONE_PHONES.difference(value)
    if missing:
        raise RuntimeError(
            f"Installed vocabulary is missing phase-one phones: {sorted(missing)}"
        )
    return value


def write_installed_vocabulary(path: Path, vocabulary: list[str]) -> None:
    path.write_text(
        json.dumps(vocabulary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def check_generated(repo_root: Path, output: str) -> None:
    installed_model, manifest_path, installed_vocabulary = output_paths(
        repo_root,
        output,
    )
    output_weight = (
        installed_model
        / "Data"
        / "com.apple.CoreML"
        / "weights"
        / "weight.bin"
    )
    output_specification = (
        installed_model
        / "Data"
        / "com.apple.CoreML"
        / "model.mlmodel"
    )
    for path in (
        output_weight,
        output_specification,
        manifest_path,
        installed_vocabulary,
    ):
        if not path.exists():
            raise RuntimeError(f"Generated asset is missing: {path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    actual_weight_hash = sha256(output_weight)
    actual_specification_hash = sha256(output_specification)
    actual_vocabulary_hash = sha256(installed_vocabulary)
    actual_size = package_size(installed_model)
    required_manifest = {
        "schemaVersion": 1,
        "identifier": "wav2vec2-lv-60-espeak-cv-ft-coreml-lut4",
        "upstreamModel": UPSTREAM_MODEL,
        "upstreamLicense": UPSTREAM_LICENSE,
        "conversionRepository": MODEL_REPOSITORY,
        "conversionRevision": MODEL_REVISION,
        "conversionID": CONVERSION_ID,
        "sourceWeightSHA256": SOURCE_FILES[
            "Data/com.apple.CoreML/weights/weight.bin"
        ][1],
        "modelWeightSHA256": EXPECTED_OUTPUT_WEIGHT_SHA256,
        "modelSpecificationSHA256": EXPECTED_OUTPUT_SPECIFICATION_SHA256,
        "vocabularySHA256": EXPECTED_OUTPUT_VOCABULARY_SHA256,
        "modelBytes": actual_size,
        "minimumIOSVersion": 26,
        "sampleRate": 16000,
        "sampleCount": 64000,
        "frameCount": 199,
        "vocabularySize": 392,
        "blankTokenID": 0,
    }
    mismatches = {
        key: (manifest.get(key), expected)
        for key, expected in required_manifest.items()
        if manifest.get(key) != expected
    }
    if mismatches:
        raise RuntimeError(f"Generated manifest mismatch: {mismatches}")
    if actual_weight_hash != EXPECTED_OUTPUT_WEIGHT_SHA256:
        raise RuntimeError(
            "Generated model SHA-256 mismatch: expected "
            f"{EXPECTED_OUTPUT_WEIGHT_SHA256}, got {actual_weight_hash}"
        )
    if actual_specification_hash != EXPECTED_OUTPUT_SPECIFICATION_SHA256:
        raise RuntimeError(
            "Generated model specification SHA-256 mismatch: expected "
            f"{EXPECTED_OUTPUT_SPECIFICATION_SHA256}, got "
            f"{actual_specification_hash}"
        )
    if actual_vocabulary_hash != EXPECTED_OUTPUT_VOCABULARY_SHA256:
        raise RuntimeError(
            "Generated vocabulary SHA-256 mismatch: expected "
            f"{EXPECTED_OUTPUT_VOCABULARY_SHA256}, got {actual_vocabulary_hash}"
        )
    if actual_size > MAX_MODEL_BYTES:
        raise RuntimeError(
            f"Generated model is {actual_size} bytes, over the "
            f"{MAX_MODEL_BYTES}-byte gate"
        )
    validate_installed_vocabulary(installed_vocabulary)


def prepare(args: argparse.Namespace) -> None:
    import coremltools as ct

    repo_root = Path(__file__).resolve().parent.parent
    cache_root = (repo_root / args.cache).resolve()
    installed_model, manifest_path, installed_vocabulary = output_paths(
        repo_root,
        args.output,
    )
    output_root = installed_model.parent
    source_package = cache_root / "Wav2Vec2Phoneme.mlpackage"
    vocabulary = cache_root / "vocab.json"

    for local_path, (remote_path, expected_hash) in SOURCE_FILES.items():
        fetch(remote_path, source_package / local_path, expected_hash)
    fetch(VOCABULARY_REMOTE_PATH, vocabulary, SOURCE_VOCABULARY_SHA256)
    vocabulary_tokens = ordered_source_vocabulary(vocabulary)

    with tempfile.TemporaryDirectory(
        prefix="voice-phone-model-",
        dir=cache_root,
    ) as temporary_directory:
        temporary_root = Path(temporary_directory)
        retargeted_path = temporary_root / "retargeted.mlpackage"
        output_path = temporary_root / "VoicePhoneModel.mlpackage"

        source_model = ct.models.MLModel(str(source_package))
        source_spec = source_model.get_spec()
        source_spec.specificationVersion = int(ct.target.iOS26)
        ct.models.MLModel(
            source_spec,
            weights_dir=source_model.weights_dir,
        ).save(str(retargeted_path))

        retargeted_model = ct.models.MLModel(str(retargeted_path))
        optimization = ct.optimize.coreml.OptimizationConfig(
            global_config=ct.optimize.coreml.OpPalettizerConfig(
                mode="kmeans",
                nbits=4,
                granularity="per_grouped_channel",
                group_size=16,
                num_kmeans_workers=args.workers,
                weight_threshold=2048,
            )
        )
        compressed = ct.optimize.coreml.palettize_weights(
            retargeted_model,
            config=optimization,
        )
        compressed.save(str(output_path))

        output_weight = (
            output_path
            / "Data"
            / "com.apple.CoreML"
            / "weights"
            / "weight.bin"
        )
        output_specification = (
            output_path
            / "Data"
            / "com.apple.CoreML"
            / "model.mlmodel"
        )
        output_hash = sha256(output_weight)
        output_specification_hash = sha256(output_specification)
        if (
            EXPECTED_OUTPUT_WEIGHT_SHA256 is not None
            and output_hash != EXPECTED_OUTPUT_WEIGHT_SHA256
        ):
            raise RuntimeError(
                "Compressed model SHA-256 mismatch: expected "
                f"{EXPECTED_OUTPUT_WEIGHT_SHA256}, got {output_hash}"
            )
        if output_specification_hash != EXPECTED_OUTPUT_SPECIFICATION_SHA256:
            raise RuntimeError(
                "Compressed model specification SHA-256 mismatch: expected "
                f"{EXPECTED_OUTPUT_SPECIFICATION_SHA256}, got "
                f"{output_specification_hash}"
            )
        size = package_size(output_path)
        if size > MAX_MODEL_BYTES:
            raise RuntimeError(
                f"Compressed model is {size} bytes, over the {MAX_MODEL_BYTES}-byte gate"
            )

        manifest = {
            "schemaVersion": 1,
            "identifier": "wav2vec2-lv-60-espeak-cv-ft-coreml-lut4",
            "upstreamModel": UPSTREAM_MODEL,
            "upstreamLicense": UPSTREAM_LICENSE,
            "conversionRepository": MODEL_REPOSITORY,
            "conversionRevision": MODEL_REVISION,
            "conversionID": CONVERSION_ID,
            "sourceWeightSHA256": SOURCE_FILES[
                "Data/com.apple.CoreML/weights/weight.bin"
            ][1],
            "modelWeightSHA256": output_hash,
            "modelSpecificationSHA256": output_specification_hash,
            "vocabularySHA256": EXPECTED_OUTPUT_VOCABULARY_SHA256,
            "modelBytes": size,
            "minimumIOSVersion": 26,
            "sampleRate": 16000,
            "sampleCount": 64000,
            "frameCount": 199,
            "vocabularySize": 392,
            "blankTokenID": 0,
        }

        output_root.mkdir(parents=True, exist_ok=True)
        if installed_model.exists():
            shutil.rmtree(installed_model)
        os.replace(output_path, installed_model)
        write_installed_vocabulary(installed_vocabulary, vocabulary_tokens)
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    check_generated(repo_root, args.output)
    print(
        json.dumps(
            {
                "model": str(installed_model),
                "modelBytes": size,
                "modelWeightSHA256": output_hash,
                "manifest": str(manifest_path),
            },
            indent=2,
            sort_keys=True,
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cache",
        default=".build/voice-phone-model/cache",
        help="Repo-relative cache directory for verified source artifacts.",
    )
    parser.add_argument(
        "--output",
        default=".build/voice-assets",
        help=(
            "Repo-relative staging directory. Not a bundle: `just "
            "voice-assets-install` publishes from here to the directory the "
            "host serves, and the phone fetches from there."
        ),
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, min(8, os.cpu_count() or 1)),
        help="Number of k-means worker processes.",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Validate the existing generated resources without Core ML Tools.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    try:
        parsed_args = parse_args()
        if parsed_args.check_only:
            check_generated(Path(__file__).resolve().parent.parent, parsed_args.output)
        else:
            prepare(parsed_args)
    except Exception as error:
        print(f"prepare-voice-phone-model: {error}", file=sys.stderr)
        raise
