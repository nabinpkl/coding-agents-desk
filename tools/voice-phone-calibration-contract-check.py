#!/usr/bin/env python3
"""Dependency-free guard for committed R131 assets and source contracts."""

from __future__ import annotations

import ast
import json
from pathlib import Path
import sys


PRODUCT_PHONES = {"θ", "s", "ɹ", "l", "v", "w", "ɪ", "iː"}
SOURCE_SHA256 = (
    "876c34b828c2ebcc35ba2ff1ba5947d50e6b0162fc4a4af91db0942422b3bdd5"
)
SOURCE_REVISION = "OpenSLR-SLR101-2021-02-02"
SOURCE_LICENSE = "CC BY 4.0"


def fail(message: str) -> None:
    raise RuntimeError(message)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    for source in (
        "tools/voice-phone-calibration.py",
        "tools/voice_phone_calibration_lib.py",
        "tools/voice-phone-calibration-tests.py",
        "tools/voice-pronunciation-model-benchmark.py",
        "tools/voice-pronunciation-model-benchmark-tests.py",
    ):
        ast.parse((root / source).read_text(encoding="utf-8"), filename=source)

    model = json.loads(
        (
            root
            / "client"
            / "AgentDeskClient"
            / "VoicePhoneModelManifest.json"
        ).read_text(encoding="utf-8")
    )
    manifest = json.loads(
        (
            root
            / "client"
            / "AgentDeskClient"
            / "VoicePhoneCalibrationManifest.json"
        ).read_text(encoding="utf-8")
    )
    mapping = json.loads(
        (
            root
            / "client"
            / "voice-phone-calibration"
            / "arpabet-model-phone-map.json"
        ).read_text(encoding="utf-8")
    )
    parity = json.loads(
        (
            root
            / "client"
            / "AgentDeskClient"
            / "VoicePhoneScoringParityFixtures.json"
        ).read_text(encoding="utf-8")
    )
    if manifest.get("schemaVersion") != 1:
        fail("Calibration manifest schema must be 1")
    if manifest.get("featureVersion") != "r131-v1":
        fail("Calibration feature version must be r131-v1")
    if manifest.get("sourceSHA256") != SOURCE_SHA256:
        fail("SpeechOcean artifact hash is not pinned")
    if manifest.get("sourceRevision") != SOURCE_REVISION:
        fail("SpeechOcean source revision is not pinned")
    if manifest.get("sourceLicense") != SOURCE_LICENSE:
        fail("SpeechOcean source license is not pinned")
    for key in (
        "modelWeightSHA256",
        "modelSpecificationSHA256",
        "vocabularySHA256",
    ):
        if manifest.get(key) != model.get(key):
            fail(f"Calibration {key} differs from the selected model")
    mapped_phones = set(mapping.get("mapping", {}).values())
    if not PRODUCT_PHONES.issubset(mapped_phones):
        fail("ARPABET mapping does not cover the product phone matrix")
    if parity.get("schemaVersion") != 1:
        fail("Python/Swift parity fixture schema must be 1")

    if manifest.get("displayEnabled"):
        validation = manifest.get("validation")
        support = {
            row["phone"] for row in manifest.get("supportedPhones", [])
        }
        if not isinstance(validation, dict):
            fail("Enabled calibration lacks validation metrics")
        support_rows = manifest.get("supportedPhones", [])
        gates = (
            validation.get("testPearsonCorrelation", -1) >= 0.50,
            validation.get("testSpearmanCorrelation", -1) >= 0.50,
            validation.get("testMeanAbsoluteError", 99) <= 0.35,
            validation.get("testAUROC", -1) >= 0.80,
            validation.get("testCalibrationError", 99) <= 0.10,
            validation.get("speakerBootstrapPearsonLowerBound", -1) >= 0.45,
            validation.get("l2ArcticOverallAUROC", -1) >= 0.70,
            validation.get("l2ArcticWorstL1AUROC", -1) >= 0.55,
            validation.get("l2ArcticWorstRecallGap", 99) <= 0.20,
            support == PRODUCT_PHONES,
            bool(manifest.get("mappings")),
            manifest.get("disabledReason") is None,
            all(
                row.get("trainingCount", 0) >= 100
                and row.get("testCount", 0) >= 20
                and row.get("lowGradeTrainingCount", 0) > 0
                and row.get("highGradeTrainingCount", 0) > 0
                and row.get("lowGradeTestCount", 0) >= 10
                and row.get("highGradeTestCount", 0) >= 10
                and row.get("testPearsonCorrelation", -1) >= 0
                and row.get("testMeanAbsoluteError", 99) <= 0.50
                for row in support_rows
            ),
        )
        if not all(gates):
            fail("Enabled calibration does not pass every release gate")
    else:
        if not manifest.get("disabledReason"):
            fail("Disabled calibration lacks a visible reason")
        if manifest.get("validation") is not None:
            fail("Unvalidated committed calibration must not claim validation")
        if manifest.get("supportedPhones") or manifest.get("mappings"):
            fail("Unvalidated committed calibration must not ship coefficients")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"voice-phone-calibration-check: {error}", file=sys.stderr)
        raise SystemExit(1)
