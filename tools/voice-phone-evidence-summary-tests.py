#!/usr/bin/env python3
"""Focused tests for the bounded voice phone evidence summary."""

from __future__ import annotations

import gzip
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("voice-phone-evidence-summary.py")
SPEC = importlib.util.spec_from_file_location("voice_phone_evidence_summary", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
SUMMARY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUMMARY)


class VoicePhoneEvidenceSummaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.manifest = self.root / "manifest.json"
        self.write_json(self.manifest, {"modelWeightSHA256": "selected-model"})

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def write_json(self, path: Path, value: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def add_attempt(self, attempt_id: str) -> Path:
        attempt = self.root / attempt_id
        self.write_json(
            attempt / "metadata.json",
            {
                "id": attempt_id,
                "createdAt": "2026-07-25T23:17:00Z",
                "targetPhrase": "think",
                "durationSeconds": 3.6,
                "build": {
                    "marketingVersion": "1.10.0",
                    "buildNumber": "812",
                    "gitSHA": "abc12345",
                },
                "analysis": {
                    "withoutContext": {"top": {"text": "tink"}},
                    "withContext": {"top": {"text": "think"}},
                    "verdict": "contextRecovered",
                },
            },
        )
        return attempt

    def test_missing_phone_evidence_is_explicit(self) -> None:
        self.add_attempt("00000000-0000-0000-0000-000000000001")

        output = "\n".join(SUMMARY.summarize(self.root, self.manifest))

        self.assertIn("attemptCount=1", output)
        self.assertIn('unaided="tink" targetBiased="think"', output)
        self.assertIn("phone-log status=missing", output)
        self.assertIn("phone status=missing", output)
        self.assertIn("Analyze raw audio has not produced phone-evidence.json", output)

    def test_crash_log_is_printed_when_phone_evidence_is_missing(self) -> None:
        attempt_id = "00000000-0000-0000-0000-000000000005"
        attempt = self.add_attempt(attempt_id)
        self.write_json(
            attempt / "phone-analysis-log.json",
            {
                "schemaVersion": 1,
                "attemptID": attempt_id,
                "modelWeightSHA256": "selected-model",
                "startedAt": "2026-07-25T23:18:00Z",
                "events": [
                    {
                        "timestamp": "2026-07-25T23:18:00Z",
                        "stage": "analysisStarted",
                        "residentMemoryBytes": 1000,
                        "details": {},
                    },
                    {
                        "timestamp": "2026-07-25T23:18:01Z",
                        "stage": "inferenceStarted",
                        "residentMemoryBytes": 2000,
                        "details": {"computeUnits": "all"},
                    },
                ],
            },
        )

        output = "\n".join(SUMMARY.summarize(self.root, self.manifest))

        self.assertIn(
            'phone-log status=present eventCount=2 lastStage="inferenceStarted"',
            output,
        )
        self.assertIn(
            'stage="inferenceStarted" residentBytes=2000 '
            'details="computeUnits=all"',
            output,
        )
        self.assertIn("phone status=missing", output)

    def test_completed_evidence_prints_aligned_phones_and_metrics(self) -> None:
        attempt_id = "00000000-0000-0000-0000-000000000002"
        attempt = self.add_attempt(attempt_id)
        self.write_json(
            attempt / "phone-evidence.json",
            {
                "attemptID": attempt_id,
                "audioSHA256": "audio-hash",
                "modelWeightSHA256": "selected-model",
                "failure": None,
                "evidence": {
                    "audioSHA256": "audio-hash",
                    "model": {"identifier": "phone-model"},
                    "alignedPhones": [
                        {
                            "targetPhone": "θ",
                            "startSeconds": 0.42,
                            "endSeconds": 0.58,
                            "targetLogPosterior": -2.1,
                            "observedPhone": {
                                "phone": "t",
                                "logPosterior": -0.4,
                            },
                            "competingPhones": [
                                {"phone": "s", "logPosterior": -1.2}
                            ],
                            "posteriorMargin": -1.7,
                        }
                    ],
                    "metrics": {
                        "sourceDurationSeconds": 3.6,
                        "modelLoadMilliseconds": 845,
                        "inferenceMilliseconds": 220,
                        "observedResidentMemoryDeltaBytes": 1048576,
                    },
                },
            },
        )

        output = "\n".join(SUMMARY.summarize(self.root, self.manifest))

        self.assertIn("phone status=completed", output)
        self.assertIn('target="θ" observed="t"', output)
        self.assertIn('competitors="s:-1.20"', output)
        self.assertIn("loadMs=845 inferenceMs=220", output)

    def test_failure_and_stale_model_remain_distinct(self) -> None:
        failed_id = "00000000-0000-0000-0000-000000000003"
        failed = self.add_attempt(failed_id)
        self.write_json(
            failed / "phone-evidence.json",
            {
                "attemptID": failed_id,
                "audioSHA256": "failed-audio",
                "modelWeightSHA256": "selected-model",
                "evidence": None,
                "failure": "model output was invalid",
            },
        )
        stale_id = "00000000-0000-0000-0000-000000000004"
        stale = self.add_attempt(stale_id)
        self.write_json(
            stale / "phone-evidence.json",
            {
                "attemptID": stale_id,
                "audioSHA256": "stale-audio",
                "modelWeightSHA256": "old-model",
                "evidence": {"audioSHA256": "stale-audio"},
                "failure": None,
            },
        )

        output = "\n".join(SUMMARY.summarize(self.root, self.manifest))

        self.assertIn('phone status=failed error="model output was invalid"', output)
        self.assertIn(
            'phone status=stale storedModel="old-model" '
            'expectedModel="selected-model"',
            output,
        )

    def test_inventory_copy_paths_exclude_audio_and_untrusted_paths(self) -> None:
        inventory = self.root / "device-files.json"
        self.write_json(
            inventory,
            {
                "result": {
                    "files": [
                        {
                            "relativePath":
                                "00000000-0000-0000-0000-000000000001/metadata.json"
                        },
                        {
                            "relativePath":
                                "00000000-0000-0000-0000-000000000001/"
                                "phone-evidence.json"
                        },
                        {
                            "relativePath":
                                "00000000-0000-0000-0000-000000000001/"
                                "phone-analysis-log.json"
                        },
                        {
                            "relativePath":
                                "00000000-0000-0000-0000-000000000001/audio.caf"
                        },
                        {"relativePath": "../../metadata.json"},
                    ]
                }
            },
        )

        paths = SUMMARY.inventory_copy_paths(inventory)

        self.assertEqual(
            paths,
            [
                "00000000-0000-0000-0000-000000000001/metadata.json",
                "00000000-0000-0000-0000-000000000001/phone-analysis-log.json",
                "00000000-0000-0000-0000-000000000001/phone-evidence.json",
            ],
        )

    def test_remote_diagnostics_summarize_crash_surviving_analyzer_stages(
        self,
    ) -> None:
        diagnostics = self.root / "diagnostics"
        diagnostics.mkdir()
        payload = diagnostics / "run-previous.ndjson.gz"
        events = [
            {
                "tsMs": 1_753_480_000_000,
                "runId": "previous",
                "type": "runStarted",
                "fields": {},
            },
            {
                "tsMs": 1_753_480_001_000,
                "runId": "previous",
                "type": "voicePhoneAnalysisStage",
                "fields": {
                    "attemptID": "00000000-0000-0000-0000-000000000006",
                    "stage": "analysisStarted",
                    "modelHash": "selected-model",
                    "eventTimestamp": "2026-07-25T23:18:00Z",
                    "residentMemoryBytes": "1000",
                },
            },
            {
                "tsMs": 1_753_480_002_000,
                "runId": "previous",
                "type": "voicePhoneAnalysisStage",
                "fields": {
                    "attemptID": "00000000-0000-0000-0000-000000000006",
                    "stage": "inferenceStarted",
                    "modelHash": "selected-model",
                    "eventTimestamp": "2026-07-25T23:18:01Z",
                    "residentMemoryBytes": "2000",
                    "detail.computeUnits": "all",
                },
            },
        ]
        with gzip.open(payload, mode="wt", encoding="utf-8") as output:
            for event in events:
                output.write(json.dumps(event))
                output.write("\n")

        summary = "\n".join(SUMMARY.summarize_diagnostics(diagnostics))

        self.assertIn("eventCount=2", summary)
        self.assertIn("attemptCount=1", summary)
        self.assertIn(
            'eventCount=2 lastStage="inferenceStarted" '
            'modelHash="selected-model"',
            summary,
        )
        self.assertIn(
            'stage="inferenceStarted" residentBytes=2000 '
            'details="computeUnits=all"',
            summary,
        )

    def test_remote_diagnostics_without_analyzer_events_is_explicit(self) -> None:
        diagnostics = self.root / "diagnostics"
        diagnostics.mkdir()
        with gzip.open(
            diagnostics / "run-current.ndjson.gz",
            mode="wt",
            encoding="utf-8",
        ) as output:
            output.write(
                json.dumps(
                    {
                        "tsMs": 1_753_480_000_000,
                        "runId": "current",
                        "type": "runStarted",
                        "fields": {},
                    }
                )
            )
            output.write("\n")

        summary = "\n".join(SUMMARY.summarize_diagnostics(diagnostics))

        self.assertIn("eventCount=0", summary)
        self.assertIn("attemptCount=0", summary)


if __name__ == "__main__":
    unittest.main()
