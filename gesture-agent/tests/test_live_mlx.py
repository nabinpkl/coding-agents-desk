from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

import numpy as np

from interaction_agent.voice import live_mlx


class MlxLiveSessionLifecycleTests(unittest.TestCase):
    def test_finish_waits_for_the_decode_completion_event(self) -> None:
        decode_started = threading.Event()
        release_decode = threading.Event()
        finish_returned = threading.Event()

        def blocking_transcription(*args, **kwargs):
            del args, kwargs
            decode_started.set()
            if not release_decode.wait(timeout=2):
                raise TimeoutError("test did not release live inference")
            return {"text": "spoken words"}

        transcriber = live_mlx.MlxLiveChunkTranscriber(
            chunk_seconds=1.0,
            interval_seconds=0.5,
            min_seconds=0.25,
        )

        with (
            patch.object(
                live_mlx,
                "transcribe_audio_path",
                side_effect=blocking_transcription,
            ),
        ):
            transcriber.start_session()
            transcriber.submit_audio(
                np.full(8_000, 0.1, dtype=np.float32),
                16_000,
            )
            self.assertTrue(decode_started.wait(timeout=1))

            finish = threading.Thread(
                target=lambda: (
                    transcriber.finish_session(),
                    finish_returned.set(),
                )
            )
            finish.start()
            try:
                self.assertFalse(
                    finish_returned.wait(timeout=0.1),
                    "finish_session returned while MLX was still decoding",
                )
            finally:
                release_decode.set()
                finish.join(timeout=2)

        self.assertFalse(finish.is_alive())
        self.assertTrue(finish_returned.is_set())
        self.assertFalse(transcriber.snapshot().is_decoding)


if __name__ == "__main__":
    unittest.main()
