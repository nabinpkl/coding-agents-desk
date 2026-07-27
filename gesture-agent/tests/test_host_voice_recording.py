from __future__ import annotations

import asyncio
import json
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from interaction_agent.voice import http_server, recording, web_stream
from interaction_agent.voice.phone_recognizer import ZIPAPhoneRecognizer
from interaction_agent.voice.recording import update_recording_metadata


class FakeTranscriber:
    def set_preamp_gain(self, gain: float) -> None:
        del gain

    def start_session(self) -> None:
        return None

    def submit_audio(self, samples: np.ndarray, sample_rate: int) -> None:
        del samples, sample_rate

    def snapshot(self) -> SimpleNamespace:
        return SimpleNamespace(preview_text="")

    def finish_session(self) -> SimpleNamespace:
        return SimpleNamespace(preview_text="")


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []

    async def send_text(self, message: str) -> None:
        self.messages.append(json.loads(message))


def test_app() -> SimpleNamespace:
    return SimpleNamespace(
        state=SimpleNamespace(
            voice_phone_recognizer=None,
            voice_phone_recognizer_lock=asyncio.Lock(),
            voice_phone_inference_lock=asyncio.Lock(),
        )
    )


class HostVoiceFinalizationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.stack = ExitStack()
        self.stack.enter_context(
            patch.object(recording, "VOICE_RECORDING_ROOT", self.root)
        )
        self.stack.enter_context(
            patch.object(web_stream, "VOICE_RECORDING_ROOT", self.root)
        )

    def tearDown(self) -> None:
        self.stack.close()
        self.temporary.cleanup()

    async def _finalize(self, source: str, status: str = "completed"):
        async def analyze(app, recording_id):
            del app
            update_recording_metadata(
                web_stream.recording_json_path(recording_id),
                {
                    "phoneAnalysis": {
                        "status": "completed",
                        "phones": ["θ", "æ", "ŋ", "k"],
                        "error": None,
                        "modelIdentifier": "zipa-test",
                        "modelHash": "abc",
                        "runtimeIdentifier": "onnxruntime-python 1.24.4",
                        "analyzedAt": "2026-07-26T22:00:00+00:00",
                    }
                },
            )
            return web_stream.load_recording(recording_id)

        with (
            patch.object(
                http_server,
                "transcribe_audio_path",
                return_value={"text": "thank"},
            ),
            patch.object(http_server, "analyze_recording_phones", analyze),
        ):
            return await http_server.finalize_session(
                test_app(),
                None,
                [np.full(2048, 0.1, dtype=np.float32)],
                16_000,
                datetime(2026, 7, 26, tzinfo=UTC),
                source,
                status,
            )

    async def test_macos_and_iphone_use_identical_finalization(self) -> None:
        mac = await self._finalize("macos")
        phone = await self._finalize("iphone")
        self.assertEqual(mac.transcript, phone.transcript)
        self.assertEqual(mac.observed_phones, phone.observed_phones)
        self.assertEqual(mac.word_phone_groups, phone.word_phone_groups)
        self.assertEqual(mac.word_phone_groups[0].word, "thank")
        self.assertEqual(
            mac.word_phone_groups[0].reference_phones,
            ["θ", "æ", "ŋ", "k"],
        )
        self.assertEqual(mac.unknown_reference_words, [])
        self.assertTrue(mac.reference_dictionary_identifier.startswith("CMUdict@"))
        self.assertEqual(mac.phone_model_identifier, phone.phone_model_identifier)
        self.assertEqual(mac.source, "macos")
        self.assertEqual(phone.source, "iphone")

    async def test_interrupted_nonempty_audio_is_retained(self) -> None:
        result = await self._finalize("iphone", "interrupted")
        self.assertEqual(result.status, "interrupted")
        self.assertTrue(web_stream.recording_wav_path(result.id).exists())

    async def test_empty_interrupted_audio_is_discarded(self) -> None:
        result = await http_server.finalize_session(
            test_app(),
            None,
            [],
            16_000,
            datetime(2026, 7, 26, tzinfo=UTC),
            "iphone",
            "interrupted",
        )
        self.assertIsNone(result)
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_empty_completed_audio_is_discarded_and_terminates_ui(self) -> None:
        websocket = FakeWebSocket()
        result = await http_server.finalize_session(
            test_app(),
            websocket,
            [],
            16_000,
            datetime(2026, 7, 26, tzinfo=UTC),
            "macos",
            "completed",
        )
        self.assertIsNone(result)
        self.assertEqual(
            websocket.messages,
            [
                {
                    "type": "sessionError",
                    "code": "invalidSession",
                    "message": "No audio was received; the recording was discarded.",
                }
            ],
        )
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_transcription_and_phone_failures_are_independent(self) -> None:
        async def fail_phones(app, recording_id):
            del app, recording_id
            raise RuntimeError("phone fixture failed")

        with (
            patch.object(
                http_server,
                "transcribe_audio_path",
                side_effect=RuntimeError("whisper fixture failed"),
            ),
            patch.object(http_server, "analyze_recording_phones", fail_phones),
        ):
            result = await http_server.finalize_session(
                test_app(),
                None,
                [np.full(2048, 0.1, dtype=np.float32)],
                16_000,
                datetime(2026, 7, 26, tzinfo=UTC),
                "macos",
                "completed",
            )
        self.assertIsNotNone(result)
        self.assertIn("whisper fixture failed", result.transcription_error)
        self.assertIn("phone fixture failed", result.phone_analysis_error)
        self.assertTrue(web_stream.recording_wav_path(result.id).exists())


class HostVoiceBusyTests(unittest.TestCase):
    def test_second_websocket_is_rejected_immediately(self) -> None:
        async def fake_get_transcriber(app):
            del app
            return FakeTranscriber()

        with patch.object(http_server, "get_transcriber", fake_get_transcriber):
            with TestClient(http_server.app) as client:
                headers = {"origin": "interactionfeed://app"}
                with client.websocket_connect(
                    "/ws/voice?source=macos",
                    headers=headers,
                ):
                    with client.websocket_connect(
                        "/ws/voice?source=iphone",
                        headers=headers,
                    ) as second:
                        message = second.receive_json()
        self.assertEqual(message["type"], "sessionError")
        self.assertEqual(message["code"], "recorderBusy")


class ZIPAParityTests(unittest.TestCase):
    def test_bundled_passage_matches_native_zipa_fixture(self) -> None:
        repo = Path(__file__).resolve().parents[2]
        source = repo / "client/AgentDeskClient/VoicePassageSample.caf"
        assets = repo / "host/AgentDeskHost/VoiceZIPAHostAssets"
        with tempfile.TemporaryDirectory() as temporary:
            wav = Path(temporary) / "sample.wav"
            subprocess.run(
                [
                    "afconvert",
                    "-f",
                    "WAVE",
                    "-d",
                    "LEI16@16000",
                    "-c",
                    "1",
                    str(source),
                    str(wav),
                ],
                check=True,
            )
            observation = ZIPAPhoneRecognizer(assets).analyze_wav(wav)
        self.assertEqual(
            observation.phones,
            (
                "aɪ", "θ", "ɔ", "t", "ə", "b", "aʊ", "t",
                "w", "ɔ", "k", "ɪ", "ŋ", "θ", "ɹ", "u",
                "ð", "ə", "k", "w", "aɪ", "ə", "t", "ɡ",
                "ɑ", "ɹ", "d", "ə", "n",
            ),
        )
        manifest = json.loads(
            (assets / "VoiceZIPAModelManifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(observation.model_hash, manifest["modelSHA256"])


if __name__ == "__main__":
    unittest.main()
