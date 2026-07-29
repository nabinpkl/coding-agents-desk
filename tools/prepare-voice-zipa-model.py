#!/usr/bin/env python3
"""Stage and verify the pinned ZIPA INT8 ONNX phone model for iOS and host."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import urllib.request


MODEL_REPOSITORY = "anyspeech/zipa-small-crctc-ns-700k"
MODEL_REVISION = "86ce6920bcf23f27f449fd21b77b9886804bd734"
MODEL_REMOTE_PATH = "model.int8.onnx"
MODEL_SHA256 = "c0a74847edb1224f90a5a1d20c501f81d841439e0692f8e32d1fe6bd94beaa77"
MODEL_BYTES = 70_677_672
TOKENS_REMOTE_PATH = "tokens.txt"
TOKENS_SHA256 = "f8e042a0c9130532b22d03ec7cae2f75a23fbec70c450c31a8efb51787b2b8fe"
TOKENS_BYTES = 769
LICENSE_REPOSITORY = "lingjzhu/zipa"
LICENSE_REVISION = "ed94d27fba14fe5ad0e289227d69d7ccc8a2eee5"
LICENSE_SHA256 = "8a17e1829b1e8c410ecb6bb3941b87a4e2e0f0ce50bd2ebf19fbb1a71c35746a"
LICENSE_BYTES = 1_061
IDENTIFIER = "zipa-small-crctc-ns-700k-int8-onnx"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url: str, destination: Path, expected_sha256: str) -> None:
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
            raise RuntimeError(
                f"SHA-256 mismatch for {url}: expected {expected_sha256}, got {actual}"
            )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def hugging_face_url(path: str) -> str:
    return (
        f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/"
        f"{MODEL_REVISION}/{path}"
    )


def github_url(path: str) -> str:
    return (
        f"https://raw.githubusercontent.com/{LICENSE_REPOSITORY}/"
        f"{LICENSE_REVISION}/{path}"
    )


def output_paths(repo_root: Path, output: str) -> tuple[Path, Path, Path, Path]:
    output_root = (repo_root / output).resolve()
    try:
        output_root.relative_to(repo_root)
    except ValueError as error:
        raise RuntimeError("output must remain inside the repository") from error
    return (
        output_root / "VoiceZIPAModel.onnx",
        output_root / "VoiceZIPAModelManifest.json",
        output_root / "VoiceZIPATokens.txt",
        output_root / "VoiceZIPALicense.txt",
    )


def parse_tokens(path: Path) -> list[str]:
    indexed: dict[int, str] = {}
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        parts = line.split()
        if len(parts) != 2:
            raise RuntimeError(f"Invalid token row {line_number}: {line!r}")
        token, raw_identifier = parts
        identifier = int(raw_identifier)
        if identifier in indexed:
            raise RuntimeError(f"Duplicate token identifier {identifier}")
        indexed[identifier] = token
    expected = set(range(127))
    if set(indexed) != expected:
        raise RuntimeError("ZIPA token IDs must be contiguous from 0 through 126")
    required = {"<blk>", "▁", "θ", "t", "s", "ð", "ɹ", "ʃ", "ː"}
    missing = required.difference(indexed.values())
    if missing:
        raise RuntimeError(f"ZIPA token inventory is missing {sorted(missing)}")
    return [indexed[index] for index in range(127)]


def required_manifest() -> dict[str, object]:
    return {
        "schemaVersion": 2,
        "identifier": IDENTIFIER,
        "upstreamModel": MODEL_REPOSITORY,
        "upstreamRevision": MODEL_REVISION,
        "upstreamLicense": "MIT",
        "licenseRepository": LICENSE_REPOSITORY,
        "licenseRevision": LICENSE_REVISION,
        "modelSHA256": MODEL_SHA256,
        "tokensSHA256": TOKENS_SHA256,
        "licenseSHA256": LICENSE_SHA256,
        "modelBytes": MODEL_BYTES,
        "sampleRate": 16_000,
        "filterbankBins": 80,
        "vocabularySize": 127,
        "blankTokenID": 0,
    }


def check_generated(repo_root: Path, output: str) -> None:
    model, manifest, tokens, license_path = output_paths(repo_root, output)
    expected_files = (
        (model, MODEL_SHA256, MODEL_BYTES),
        (tokens, TOKENS_SHA256, TOKENS_BYTES),
        (license_path, LICENSE_SHA256, LICENSE_BYTES),
    )
    for path, expected_hash, expected_bytes in expected_files:
        if not path.exists():
            raise RuntimeError(f"Generated asset is missing: {path}")
        if path.stat().st_size != expected_bytes:
            raise RuntimeError(
                f"{path.name} has {path.stat().st_size} bytes; "
                f"expected {expected_bytes}"
            )
        actual_hash = sha256(path)
        if actual_hash != expected_hash:
            raise RuntimeError(
                f"{path.name} SHA-256 mismatch: expected "
                f"{expected_hash}, got {actual_hash}"
            )
    parse_tokens(tokens)
    if not manifest.exists():
        raise RuntimeError(f"Generated asset is missing: {manifest}")
    value = json.loads(manifest.read_text(encoding="utf-8"))
    if value != required_manifest():
        raise RuntimeError("Generated ZIPA manifest is stale or invalid")


def prepare(repo_root: Path, cache: str, outputs: list[str]) -> None:
    cache_root = (repo_root / cache).resolve()
    try:
        cache_root.relative_to(repo_root)
    except ValueError as error:
        raise RuntimeError("cache must remain inside the repository") from error
    cached_model = cache_root / MODEL_REMOTE_PATH
    cached_tokens = cache_root / TOKENS_REMOTE_PATH
    cached_license = cache_root / "LICENSE"
    fetch(hugging_face_url(MODEL_REMOTE_PATH), cached_model, MODEL_SHA256)
    fetch(hugging_face_url(TOKENS_REMOTE_PATH), cached_tokens, TOKENS_SHA256)
    fetch(github_url("LICENSE"), cached_license, LICENSE_SHA256)
    parse_tokens(cached_tokens)

    staged: list[dict[str, object]] = []
    for output in outputs:
        installed_model, manifest, installed_tokens, installed_license = output_paths(
            repo_root,
            output,
        )
        installed_model.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cached_model, installed_model)
        shutil.copyfile(cached_tokens, installed_tokens)
        shutil.copyfile(cached_license, installed_license)
        manifest.write_text(
            json.dumps(required_manifest(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        check_generated(repo_root, output)
        staged.append(
            {
                "manifest": str(manifest),
                "model": str(installed_model),
            }
        )
    print(
        json.dumps(
            {
                "outputs": staged,
                "modelBytes": MODEL_BYTES,
                "modelSHA256": MODEL_SHA256,
            },
            indent=2,
            sort_keys=True,
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cache",
        default=".build/voice-zipa-model/cache",
        help="Repo-relative cache directory for verified source artifacts.",
    )
    parser.add_argument(
        "--output",
        action="append",
        help=(
            "Repo-relative staging directory. Repeat for multiple consumers; "
            "defaults to the one staging root that `just voice-assets-install` "
            "publishes from."
        ),
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Validate existing generated resources without downloading.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    try:
        arguments = parse_args()
        root = Path(__file__).resolve().parent.parent
        outputs = arguments.output or [".build/voice-assets"]
        if arguments.check_only:
            for output in outputs:
                check_generated(root, output)
        else:
            prepare(root, arguments.cache, outputs)
    except Exception as error:
        print(f"prepare-voice-zipa-model: {error}", file=sys.stderr)
        raise
