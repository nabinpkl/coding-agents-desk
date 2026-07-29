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
from interaction_agent.voice.reference_speech import ReferenceSpeechArtifact


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

    async def _finalize(
        self,
        source: str,
        status: str = "completed",
        client_session_id: str | None = None,
    ):
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
                client_session_id,
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
        client_session_id = "11111111-2222-3333-4444-555555555555"
        result = await self._finalize(
            "iphone",
            "interrupted",
            client_session_id,
        )
        self.assertEqual(result.status, "interrupted")
        self.assertEqual(result.client_session_id, client_session_id)
        self.assertEqual(
            web_stream.load_recording_by_client_session_id(
                client_session_id
            ),
            result,
        )
        self.assertTrue(web_stream.recording_wav_path(result.id).exists())

    async def test_recording_wire_preserves_client_session_id_acronym(
        self,
    ) -> None:
        client_session_id = "11111111-2222-3333-4444-555555555555"
        result = await self._finalize(
            "iphone",
            "completed",
            client_session_id,
        )

        payload = http_server.SessionCompleteMessage(
            recording=result
        ).model_dump(by_alias=True)

        self.assertEqual(
            payload["recording"]["clientSessionID"],
            client_session_id,
        )
        self.assertNotIn("clientSessionId", payload["recording"])

    async def test_progress_failure_cannot_precede_wav_persistence(self) -> None:
        persisted = False

        def save(*args, **kwargs):
            nonlocal persisted
            persisted = True
            return recording.save_voice_recording(*args, **kwargs)

        async def fail_progress(*args, **kwargs):
            del args, kwargs
            raise RuntimeError("client disconnected")

        async def analyze(app, recording_id):
            del app
            return web_stream.load_recording(recording_id)

        with (
            patch.object(http_server, "save_voice_recording", save),
            patch.object(http_server, "send_progress", fail_progress),
            patch.object(
                http_server,
                "transcribe_audio_path",
                return_value={"text": "thank"},
            ),
            patch.object(http_server, "analyze_recording_phones", analyze),
        ):
            result = await http_server.finalize_session(
                test_app(),
                FakeWebSocket(),
                [np.full(2048, 0.1, dtype=np.float32)],
                16_000,
                datetime(2026, 7, 26, tzinfo=UTC),
                "iphone",
                "completed",
                "11111111-2222-3333-4444-555555555555",
            )

        self.assertTrue(persisted)
        self.assertEqual(result.transcript, "thank")
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


class ReferenceSpeechHTTPTests(unittest.TestCase):
    def test_state_artifact_and_audio_use_one_store(self) -> None:
        class FakeStore:
            def __init__(self, audio_path: Path) -> None:
                self.audio_path_value = audio_path
                self.received: dict[str, object] | None = None

            def state(self) -> dict[str, object]:
                return {
                    "schemaVersion": 1,
                    "status": "ready",
                    "error": None,
                    "language": "en-US",
                    "voices": [
                        {
                            "identifier": "af_heart",
                            "name": "Heart",
                            "language": "en-US",
                        }
                    ],
                    "defaultVoiceIdentifier": "af_heart",
                    "speed": {
                        "minimum": 0.5,
                        "defaultValue": 1,
                        "maximum": 2,
                    },
                    "modelIdentifier": "kokoro-test",
                    "modelHash": "a" * 64,
                    "runtimeIdentifier": "kokoro-python 0.9.4",
                    "license": "Apache-2.0",
                    "cacheBytes": 44,
                    "cacheMaximumBytes": 1000,
                }

            def create(self, **kwargs):
                self.received = kwargs
                return ReferenceSpeechArtifact(
                    id="b" * 64,
                    audio_hash="f" * 64,
                    text="thank",
                    ipa="θˈæŋk",
                    duration_seconds=0.1,
                    sample_rate=24_000,
                    cache_hit=False,
                    voice_identifier="af_heart",
                    speed=0.85,
                    model_identifier="kokoro-test",
                    model_hash="a" * 64,
                    voice_hash="c" * 64,
                    dictionary_identifier="CMUdict@test",
                    dictionary_hash="d" * 64,
                    synthesis_mapping_hash="e" * 64,
                    synthesized_at="2026-07-27T00:00:00+00:00",
                )

            def audio_path(self, artifact_id: str) -> Path:
                self.last_audio_id = artifact_id
                return self.audio_path_value

        with tempfile.TemporaryDirectory() as temporary:
            audio_path = Path(temporary) / "reference.wav"
            audio_path.write_bytes(b"RIFF-test")
            fake = FakeStore(audio_path)
            with TestClient(http_server.app) as client:
                http_server.app.state.reference_speech_store = fake
                state = client.get("/reference-speech/state")
                created = client.post(
                    "/reference-speech/artifacts",
                    json={
                        "recordingId": "session-20260727-010101-000001",
                        "scope": {"kind": "word", "index": 0},
                        "voiceIdentifier": "af_heart",
                        "speed": 0.85,
                    },
                )
                audio = client.get(
                    f"/reference-speech/artifacts/{'b' * 64}/audio"
                )
        self.assertEqual(state.status_code, 200)
        self.assertEqual(state.json()["defaultVoiceIdentifier"], "af_heart")
        self.assertEqual(created.status_code, 200)
        self.assertEqual(created.json()["ipa"], "θˈæŋk")
        self.assertEqual(fake.received["voice_identifier"], "af_heart")
        self.assertEqual(audio.status_code, 200)
        self.assertEqual(audio.content, b"RIFF-test")


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
