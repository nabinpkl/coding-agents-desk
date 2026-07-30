from __future__ import annotations

import json
import tempfile
import time
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from interaction_agent.voice.reference_speech import (
    KOKORO_MAX_PHONEME_CHARACTERS,
    KOKORO_PREWARM_IPA,
    KokoroDirectSynthesizer,
    ReferenceSpeechArtifactStore,
    ReferenceSpeechError,
    ReferenceSpeechScope,
    chunk_kokoro_ipa,
)


class FakeSynthesizer:
    status = "ready"
    error = None

    def __init__(self) -> None:
        self.prewarm_calls = 0
        self.calls: list[tuple[tuple[str, ...], str, float]] = []

    def prewarm(self):
        self.prewarm_calls += 1
        return True

    def synthesize(self, chunks, voice, speed):
        self.calls.append((chunks, voice.identifier, speed))
        return np.linspace(-0.25, 0.25, 2_400, dtype=np.float32)


class ReferenceSpeechArtifactStoreTests(unittest.TestCase):
    def test_direct_prewarm_exercises_default_voice_once(self) -> None:
        class ProbeSynthesizer(KokoroDirectSynthesizer):
            def __init__(self) -> None:
                super().__init__()
                self.received = None

            def synthesize(self, chunks, voice, speed):
                self.received = (chunks, voice.identifier, speed)
                self._inference_warm = True
                return np.ones(24, dtype=np.float32)

        synth = ProbeSynthesizer()

        self.assertTrue(synth.prewarm())
        self.assertFalse(synth.prewarm())
        self.assertEqual(
            synth.received,
            ((KOKORO_PREWARM_IPA,), "af_heart", 1.0),
        )

    def test_prewarm_uses_the_retained_synthesizer_without_writing_an_artifact(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            root = Path(temporary_directory)
            store = ReferenceSpeechArtifactStore(
                root=root,
                recording_loader=lambda _: SimpleNamespace(transcript="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )

            self.assertTrue(store.prewarm())
            self.assertEqual(synth.prewarm_calls, 1)
            self.assertFalse((root / "artifacts").exists())

    def test_passage_uses_direct_cmu_ipa_and_reuses_atomic_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                recording_loader=lambda _: SimpleNamespace(transcript="Think, thank."),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            first = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=0.85,
            )
            second = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=0.85,
            )

            self.assertEqual(first.ipa, "θˈɪŋk, θˈæŋk.")
            self.assertFalse(first.cache_hit)
            self.assertTrue(second.cache_hit)
            self.assertEqual(first.id, second.id)
            self.assertEqual(len(synth.calls), 1)
            self.assertEqual(synth.calls[0][0], ("θˈɪŋk, θˈæŋk.",))

            audio_path = store.audio_path(first.id)
            with wave.open(str(audio_path), "rb") as audio:
                self.assertEqual(audio.getframerate(), 24_000)
                self.assertEqual(audio.getnchannels(), 1)
                self.assertEqual(audio.getsampwidth(), 2)
            metadata = json.loads(
                audio_path.with_suffix(".json").read_text(encoding="utf-8")
            )
            self.assertEqual(metadata["audioHash"], first.audio_hash)
            self.assertEqual(metadata["dictionaryHash"], first.dictionary_hash)
            self.assertEqual(metadata["voiceHash"], first.voice_hash)

    def test_word_scope_uses_saved_word_index_and_changes_cache_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                recording_loader=lambda _: SimpleNamespace(transcript="Think thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            think = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="word", index=0),
                voice_identifier="af_heart",
                speed=1,
            )
            thank = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="word", index=1),
                voice_identifier="af_heart",
                speed=1,
            )
            faster = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="word", index=1),
                voice_identifier="af_heart",
                speed=1.1,
            )
            self.assertEqual((think.ipa, thank.ipa), ("θˈɪŋk", "θˈæŋk"))
            self.assertNotEqual(think.id, thank.id)
            self.assertNotEqual(thank.id, faster.id)

    def test_unknown_word_fails_without_calling_synthesizer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                recording_loader=lambda _: SimpleNamespace(transcript="xyzzynotaword"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            with self.assertRaisesRegex(
                ReferenceSpeechError,
                "CMUdict has no pronunciation",
            ):
                store.create(
                    recording_id="session-20260727-010101-000001",
                    scope=ReferenceSpeechScope(kind="passage"),
                    voice_identifier="af_heart",
                    speed=1,
                )
            self.assertEqual(synth.calls, [])

    def test_passage_spells_uppercase_initialism_without_text_g2p(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                recording_loader=lambda _: SimpleNamespace(
                    transcript="Choose auto-ACS."
                ),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            artifact = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )

            self.assertIn("ˈA sˈi ˈɛs", artifact.ipa)
            self.assertEqual(synth.calls[0][0], (artifact.ipa,))

    def test_corrupt_cache_pair_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                recording_loader=lambda _: SimpleNamespace(transcript="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            artifact = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            store.audio_path(artifact.id).with_suffix(".json").write_text(
                "{}",
                encoding="utf-8",
            )
            replaced = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            self.assertFalse(replaced.cache_hit)
            self.assertEqual(len(synth.calls), 2)

    def test_corrupt_audio_is_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                recording_loader=lambda _: SimpleNamespace(transcript="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            artifact = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            store.audio_path(artifact.id).write_bytes(b"corrupt")
            replaced = store.create(
                recording_id="session-20260727-010101-000001",
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            self.assertFalse(replaced.cache_hit)
            self.assertEqual(len(synth.calls), 2)

    def test_concurrent_identical_requests_coalesce_to_one_synthesis(self) -> None:
        class SlowSynthesizer(FakeSynthesizer):
            def synthesize(self, chunks, voice, speed):
                time.sleep(0.05)
                return super().synthesize(chunks, voice, speed)

        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = SlowSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                recording_loader=lambda _: SimpleNamespace(transcript="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )

            def create():
                return store.create(
                    recording_id="session-20260727-010101-000001",
                    scope=ReferenceSpeechScope(kind="passage"),
                    voice_identifier="af_heart",
                    speed=1,
                )

            with ThreadPoolExecutor(max_workers=2) as executor:
                first, second = executor.map(lambda _: create(), range(2))

            self.assertEqual(first.id, second.id)
            self.assertEqual({first.cache_hit, second.cache_hit}, {False, True})
            self.assertEqual(len(synth.calls), 1)

    def test_chunking_respects_hard_limit_and_word_boundaries(self) -> None:
        unit = "θˈɪŋk"
        chunks = chunk_kokoro_ipa(" ".join([unit] * 200))
        self.assertGreater(len(chunks), 1)
        self.assertTrue(
            all(len(chunk) <= KOKORO_MAX_PHONEME_CHARACTERS for chunk in chunks)
        )
        self.assertEqual(
            tuple(word for chunk in chunks for word in chunk.split()),
            tuple([unit] * 200),
        )


if __name__ == "__main__":
    unittest.main()
