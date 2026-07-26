#!/usr/bin/env python3
"""Focused tests for the offline R131 calibration contract."""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "tools"))
import voice_phone_calibration_lib as calibration  # noqa: E402


def load_cli_module():
    path = REPO_ROOT / "tools" / "voice-phone-calibration.py"
    spec = importlib.util.spec_from_file_location(
        "voice_phone_calibration_cli",
        path,
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FormulaParityTests(unittest.TestCase):
    def fixture(self) -> dict[str, object]:
        return json.loads(
            (
                REPO_ROOT
                / "client"
                / "AgentDeskClient"
                / "VoicePhoneScoringParityFixtures.json"
            ).read_text(encoding="utf-8")
        )

    def test_ctc_fixture_matches_swift_expected_values(self) -> None:
        ctc = self.fixture()["ctc"]
        posteriors = np.asarray(ctc["logPosteriors"], dtype=np.float64)
        canonical = calibration.ctc_sequence_log_probability(
            posteriors,
            ctc["targetTokenIDs"],
            ctc["blankTokenID"],
        )
        contrast = calibration.phone_score_features(
            logits=posteriors.astype(np.float32),
            posteriors=posteriors,
            target_token_ids=ctc["targetTokenIDs"],
            target_index=ctc["targetIndex"],
            aligned_range=(0, 1),
            assessment_token_ids=ctc["assessmentTokenIDs"],
            blank_token_id=ctc["blankTokenID"],
            excluded_token_ids={0},
            vocabulary=["<pad>", "θ", "t"],
        )

        self.assertAlmostEqual(
            canonical,
            ctc["expectedCanonicalLogProbability"],
            places=9,
        )
        self.assertAlmostEqual(
            contrast["substitutionSequenceLogSumProbability"],
            ctc["expectedSubstitutionLogSumProbability"],
            places=9,
        )
        self.assertAlmostEqual(
            contrast["deletionSequenceLogProbability"],
            ctc["expectedDeletionLogProbability"],
            places=9,
        )
        self.assertAlmostEqual(
            contrast["alignedPosteriorMargin"],
            ctc["expectedAlignedPosteriorMargin"],
            places=7,
        )
        self.assertAlmostEqual(
            contrast["alignedLogitMargin"],
            ctc["expectedAlignedLogitMargin"],
            places=7,
        )
        self.assertEqual(
            contrast["effectiveNonBlankFrameCount"],
            ctc["expectedEffectiveNonBlankFrameCount"],
        )
        self.assertEqual(
            contrast["blankFrameRatio"],
            ctc["expectedBlankFrameRatio"],
        )

    def test_pcm16_normalization_matches_swift_fixture(self) -> None:
        audio = self.fixture()["audioNormalization"]
        samples = (
            np.asarray(audio["pcm16"], dtype=np.int16).astype(np.float32)
            / 32768
        )
        np.testing.assert_allclose(
            samples,
            np.asarray(audio["expectedFloat32"], dtype=np.float32),
            rtol=0,
            atol=1e-7,
        )

    def test_calibration_fixture_interpolates_on_native_scale(self) -> None:
        fixture = self.fixture()["calibration"]
        self.assertEqual(
            calibration.predict_knots(
                [fixture["margin"]],
                fixture["knots"],
            ),
            [fixture["expectedGrade"]],
        )


class CandidateSelectionTests(unittest.TestCase):
    def rows(self) -> list[dict[str, object]]:
        rows = []
        for speaker_index in range(10):
            for observation in range(30):
                grade = (observation % 3)
                useful = grade - 1 + speaker_index * 0.001
                rows.append(
                    {
                        "speaker": f"S{speaker_index:02d}",
                        "phone": calibration.PRODUCT_PHONES[
                            observation % len(calibration.PRODUCT_PHONES)
                        ],
                        "grade": float(grade),
                        "ageGroup": (
                            "child" if speaker_index < 5 else "adult"
                        ),
                        "gender": "f" if speaker_index % 2 else "m",
                        "alignedPosteriorMargin": useful,
                        "alignedLogitMargin": useful - 0.005,
                        "alignmentFreeSubstitutionMargin":
                            -useful + (observation % 2) * 0.1,
                        "alignmentFreeSubstitutionDeletionMargin":
                            -useful,
                    }
                )
        return rows

    def test_simplest_near_best_candidate_wins(self) -> None:
        rows = self.rows()
        reports = {
            candidate: calibration.grouped_cross_validation(rows, candidate)
            for candidate in calibration.CANDIDATES
        }
        self.assertEqual(
            calibration.choose_candidate(reports),
            "alignedPosteriorMargin",
        )

    def test_training_selection_freezes_before_test_labels(self) -> None:
        module = load_cli_module()
        rows = self.rows()
        selection = module.freeze_training_selection(rows)
        self.assertEqual(selection["schemaVersion"], 1)
        self.assertEqual(
            selection["featureVersion"],
            calibration.FEATURE_VERSION,
        )
        self.assertFalse(selection["testLabelsOpened"])
        self.assertIn(selection["selectedCandidate"], calibration.CANDIDATES)
        self.assertGreaterEqual(len(selection["globalKnots"]), 2)
        module.validate_training_selection(selection, rows)
        rows[0]["grade"] = 2.0
        with self.assertRaisesRegex(
            calibration.CalibrationError,
            "missing or stale",
        ):
            module.validate_training_selection(selection, rows)


class CorpusContractTests(unittest.TestCase):
    def test_mapping_covers_product_inventory_and_selected_vocabulary(self) -> None:
        module = load_cli_module()
        mapping = module.load_mapping(REPO_ROOT)
        vocabulary, by_token = module.load_vocabulary(REPO_ROOT)
        self.assertEqual(len(vocabulary), 392)
        self.assertTrue(
            set(calibration.PRODUCT_PHONES).issubset(set(mapping.values()))
        )
        self.assertFalse(set(mapping.values()).difference(by_token))

    def test_kaldi_split_audit_rejects_speaker_overlap(self) -> None:
        module = load_cli_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scores = {}
            for split in ("train", "test"):
                split_root = root / split
                split_root.mkdir()
                (split_root / "utt2spk").write_text(
                    "u1 shared\n",
                    encoding="utf-8",
                )
                (split_root / "spk2age").write_text(
                    "shared 20\n",
                    encoding="utf-8",
                )
                (split_root / "spk2gender").write_text(
                    "shared m\n",
                    encoding="utf-8",
                )
                (split_root / "wav.scp").write_text(
                    "u1 missing.wav\n",
                    encoding="utf-8",
                )
                scores["u1"] = {}
            (root / "scores.json").write_text(
                json.dumps(scores),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                calibration.CalibrationError,
                "overlaps",
            ):
                module.audit_corpus(root)

    def test_log_sum_exp_stays_finite_for_small_probabilities(self) -> None:
        result = calibration.log_sum_exp((-10_000.0, -10_001.0))
        self.assertTrue(math.isfinite(result))
        self.assertGreater(result, -10_001)


if __name__ == "__main__":
    unittest.main()
