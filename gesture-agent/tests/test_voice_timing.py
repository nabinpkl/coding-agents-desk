from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from interaction_agent.voice import runtime
from interaction_agent.voice.timing import emit_voice_timing


class VoiceTimingEventTests(unittest.TestCase):
    def test_emits_one_compact_flushable_json_line(self) -> None:
        output = io.StringIO()

        with redirect_stdout(output):
            emit_voice_timing(
                "voiceSession",
                recordingID="session-123",
                postStopMs=123.4567,
                success=True,
            )

        payload = json.loads(output.getvalue())
        self.assertEqual(payload["event"], "voice-timing")
        self.assertEqual(payload["stage"], "voiceSession")
        self.assertEqual(payload["recordingID"], "session-123")
        self.assertEqual(payload["postStopMs"], 123.457)
        self.assertTrue(payload["success"])
        self.assertTrue(output.getvalue().endswith("\n"))

    def test_mlx_events_distinguish_cold_and_warm_calls(self) -> None:
        events: list[dict[str, object]] = []

        def capture(stage: str, **fields: object) -> None:
            events.append({"stage": stage, **fields})

        options = runtime.VoiceTranscriptionOptions(
            model=runtime.FAST_MODEL,
            purpose="final",
        )
        with (
            patch.object(runtime, "ensure_local_model", return_value=Path("/model")),
            patch("mlx_whisper.transcribe", return_value={"text": "spoken words"}),
            patch.object(runtime, "emit_voice_timing", side_effect=capture),
            patch.object(runtime, "_MLX_MODELS_SEEN", set()),
        ):
            runtime.transcribe_audio_path(Path("/first.wav"), options)
            runtime.transcribe_audio_path(Path("/second.wav"), options)

        mlx_events = [
            event for event in events if event["stage"] == "mlxTranscription"
        ]
        self.assertEqual(len(mlx_events), 2)
        self.assertTrue(mlx_events[0]["coldStart"])
        self.assertFalse(mlx_events[1]["coldStart"])
        self.assertEqual(mlx_events[0]["purpose"], "final")
        for event in mlx_events:
            self.assertTrue(event["success"])
            self.assertGreaterEqual(event["queueWaitMs"], 0)
            self.assertGreaterEqual(event["mlxCallMs"], 0)
            self.assertGreaterEqual(event["totalMs"], event["mlxCallMs"])


if __name__ == "__main__":
    unittest.main()
