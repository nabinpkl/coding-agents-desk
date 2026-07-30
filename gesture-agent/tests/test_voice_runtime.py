from __future__ import annotations

import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from interaction_agent.voice import runtime


class VoiceInferenceOwnershipTests(unittest.TestCase):
    def test_transcriptions_are_serialized_by_one_process_owner(self) -> None:
        first_started = threading.Event()
        second_started = threading.Event()
        release_first = threading.Event()
        state_lock = threading.Lock()
        call_count = 0
        active_calls = 0
        maximum_active_calls = 0
        errors: list[BaseException] = []

        def fake_transcribe(*args, **kwargs):
            del args, kwargs
            nonlocal call_count, active_calls, maximum_active_calls
            with state_lock:
                call_index = call_count
                call_count += 1
                active_calls += 1
                maximum_active_calls = max(maximum_active_calls, active_calls)
            try:
                if call_index == 0:
                    first_started.set()
                    if not release_first.wait(timeout=2):
                        raise TimeoutError("test did not release first inference")
                else:
                    second_started.set()
                return {"text": "spoken words"}
            finally:
                with state_lock:
                    active_calls -= 1

        options = runtime.VoiceTranscriptionOptions(model=runtime.FAST_MODEL)

        def transcribe(path: Path) -> None:
            try:
                runtime.transcribe_audio_path(path, options)
            except BaseException as exc:
                errors.append(exc)

        with (
            patch.object(runtime, "ensure_local_model", return_value=Path("/model")),
            patch("mlx_whisper.transcribe", side_effect=fake_transcribe),
        ):
            first = threading.Thread(
                target=transcribe,
                args=(Path("/first.wav"),),
            )
            second = threading.Thread(
                target=transcribe,
                args=(Path("/second.wav"),),
            )
            first.start()
            self.assertTrue(first_started.wait(timeout=1))
            second.start()
            try:
                self.assertFalse(
                    second_started.wait(timeout=0.1),
                    "second MLX inference started before the first completed",
                )
            finally:
                release_first.set()
                first.join(timeout=2)
                second.join(timeout=2)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(maximum_active_calls, 1)

    def test_prewarm_makes_the_first_real_transcription_warm(self) -> None:
        from mlx_whisper.transcribe import ModelHolder

        events: list[dict[str, object]] = []
        calls: list[object] = []
        resident_model = object()
        previous_model = ModelHolder.model
        previous_model_path = ModelHolder.model_path

        def fake_transcribe(audio, **kwargs):
            calls.append(audio)
            ModelHolder.model = resident_model
            ModelHolder.model_path = kwargs["path_or_hf_repo"]
            return {"text": "", "segments": []}

        def capture(stage: str, **fields: object) -> None:
            events.append({"stage": stage, **fields})

        options = runtime.VoiceTranscriptionOptions(model=runtime.FAST_MODEL)
        try:
            ModelHolder.model = None
            ModelHolder.model_path = None
            with (
                patch.object(
                    runtime,
                    "ensure_local_model",
                    return_value=Path("/model"),
                ),
                patch("mlx_whisper.transcribe", side_effect=fake_transcribe),
                patch.object(runtime, "emit_voice_timing", side_effect=capture),
                patch.object(runtime, "_MLX_MODELS_SEEN", set()),
            ):
                runtime.prewarm_transcription_model(runtime.FAST_MODEL)
                runtime.prewarm_transcription_model(runtime.FAST_MODEL)
                runtime.transcribe_audio_path(Path("/recording.wav"), options)
        finally:
            ModelHolder.model = previous_model
            ModelHolder.model_path = previous_model_path

        self.assertEqual(len(calls), 2)
        self.assertIsInstance(calls[0], np.ndarray)
        np.testing.assert_array_equal(
            calls[0],
            np.zeros(runtime.PREWARM_SAMPLE_COUNT, dtype=np.float32),
        )
        self.assertEqual(calls[1], "/recording.wav")
        prewarm_events = [
            event for event in events if event["stage"] == "mlxPrewarm"
        ]
        self.assertEqual(len(prewarm_events), 2)
        self.assertFalse(prewarm_events[0]["modelResidentBeforeCall"])
        self.assertTrue(prewarm_events[0]["modelResidentAfterCall"])
        self.assertTrue(prewarm_events[1]["modelResidentBeforeCall"])
        self.assertEqual(prewarm_events[1]["inferenceMs"], 0)
        transcription = next(
            event for event in events if event["stage"] == "mlxTranscription"
        )
        self.assertFalse(transcription["coldStart"])
        self.assertTrue(transcription["modelResidentBeforeCall"])

    def test_failed_prewarm_does_not_mark_the_model_warm(self) -> None:
        from mlx_whisper.transcribe import ModelHolder

        events: list[dict[str, object]] = []
        seen_models: set[str] = set()
        previous_model = ModelHolder.model
        previous_model_path = ModelHolder.model_path
        try:
            ModelHolder.model = None
            ModelHolder.model_path = None
            with (
                patch.object(
                    runtime,
                    "ensure_local_model",
                    return_value=Path("/model"),
                ),
                patch(
                    "mlx_whisper.transcribe",
                    side_effect=RuntimeError("prewarm failed"),
                ),
                patch.object(
                    runtime,
                    "emit_voice_timing",
                    side_effect=lambda stage, **fields: events.append(
                        {"stage": stage, **fields}
                    ),
                ),
                patch.object(runtime, "_MLX_MODELS_SEEN", seen_models),
                self.assertRaisesRegex(RuntimeError, "prewarm failed"),
            ):
                runtime.prewarm_transcription_model(runtime.FAST_MODEL)
        finally:
            ModelHolder.model = previous_model
            ModelHolder.model_path = previous_model_path

        self.assertNotIn(runtime.FAST_MODEL, seen_models)
        self.assertEqual(events[-1]["stage"], "mlxPrewarm")
        self.assertFalse(events[-1]["success"])
        self.assertEqual(events[-1]["errorType"], "RuntimeError")


class VoiceTranscriptionValidationTests(unittest.TestCase):
    def test_rejects_corrupt_segment_metrics_and_timing(self) -> None:
        result = {
            "text": "!!!!!!!!",
            "duration": 15.0,
            "segments": [
                {
                    "start": 4.0,
                    "end": 2.0,
                    "text": "!!!!!!!!",
                    "avg_logprob": None,
                    "compression_ratio": 6.25,
                }
            ],
        }

        with self.assertRaisesRegex(
            runtime.VoiceRuntimeError,
            "transcription",
        ):
            runtime.validate_transcription_result(
                result,
                audio_duration_seconds=2.696,
                require_usable_text=True,
            )

    def test_rejects_punctuation_only_dictation(self) -> None:
        with self.assertRaisesRegex(
            runtime.VoiceRuntimeError,
            "usable speech",
        ):
            runtime.validate_transcription_result(
                {"text": "!!!!!!!!", "segments": []},
                audio_duration_seconds=2.696,
                require_usable_text=True,
            )

    def test_accepts_usable_text_with_bounded_monotonic_segments(self) -> None:
        text = runtime.validate_transcription_result(
            {
                "text": "Hello there.",
                "duration": 2.5,
                "segments": [
                    {
                        "start": 0.0,
                        "end": 2.5,
                        "text": "Hello there.",
                        "avg_logprob": -0.2,
                        "compression_ratio": 1.1,
                        "no_speech_prob": 0.01,
                    }
                ],
            },
            audio_duration_seconds=2.696,
            require_usable_text=True,
        )

        self.assertEqual(text, "Hello there.")


if __name__ == "__main__":
    unittest.main()
