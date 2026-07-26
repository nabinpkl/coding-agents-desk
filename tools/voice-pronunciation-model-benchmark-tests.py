#!/usr/bin/env python3
"""Focused tests for the offline pronunciation-model benchmark."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]


def load_benchmark_module():
    path = REPO_ROOT / "tools" / "voice-pronunciation-model-benchmark.py"
    spec = importlib.util.spec_from_file_location(
        "voice_pronunciation_model_benchmark",
        path,
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


benchmark = load_benchmark_module()


class MetricTests(unittest.TestCase):
    def test_identical_ranked_predictions_pass_the_gate(self) -> None:
        values = np.asarray([0.0, 0.5, 1.0, 1.5, 2.0])
        metrics = benchmark.score_metrics(values, values)
        self.assertAlmostEqual(metrics["phonePearson"], 1.0)
        self.assertAlmostEqual(metrics["phoneSpearman"], 1.0)
        self.assertAlmostEqual(metrics["phoneMSE"], 0.0)

    def test_inverted_predictions_fail_correlation(self) -> None:
        expected = np.asarray([0.0, 0.5, 1.0, 1.5, 2.0])
        metrics = benchmark.score_metrics(expected[::-1], expected)
        self.assertAlmostEqual(metrics["phonePearson"], -1.0)
        self.assertAlmostEqual(metrics["phoneSpearman"], -1.0)

    def test_invalid_metric_shapes_fail_loudly(self) -> None:
        with self.assertRaisesRegex(
            benchmark.BenchmarkError,
            "matching non-trivial arrays",
        ):
            benchmark.score_metrics([1.0], [1.0, 2.0])

    def test_full_gate_rejects_pearson_only_success(self) -> None:
        self.assertFalse(
            benchmark.passes_scorer_gate(
                {
                    "phonePearson": 0.618,
                    "phoneSpearman": 0.438,
                    "phoneMSE": 0.083,
                }
            )
        )


class CompatibilityTests(unittest.TestCase):
    def test_upstream_gopt_features_are_not_current_app_evidence(self) -> None:
        report = benchmark.compatibility_report()
        self.assertFalse(report["compatible"])
        self.assertEqual(report["candidateFeatureDimension"], 84)
        self.assertEqual(report["currentCalibrationCandidateDimension"], 4)
        self.assertIn("Kaldi", report["candidateFeatureExtractor"])


if __name__ == "__main__":
    unittest.main()
