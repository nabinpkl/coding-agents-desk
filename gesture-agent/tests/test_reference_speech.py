from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from interaction_agent.voice.config import DEFAULT_REFERENCE_SPEECH_CACHE_BYTES
from interaction_agent.voice.practice_passages import PracticePassageStore
from interaction_agent.voice.reference_speech import (
    KOKORO_MAX_PHONEME_CHARACTERS,
    KOKORO_PREWARM_IPA,
    KokoroDirectSynthesizer,
    ReferenceSpeechArtifactStore,
    ReferenceSpeechError,
    ReferenceSpeechRevisionConflict,
    ReferenceSpeechScope,
    ReferenceSpeechSynthesisError,
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
    def test_zero_attempt_passage_can_generate_reference_audio(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            passage_store = PracticePassageStore(root / "recordings")
            passage = passage_store.create_passage("Hello")
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=root / "reference-speech",
                passage_loader=passage_store.get_passage,
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )

            artifact = store.create(
                passage_id=passage.id,
                passage_revision=passage.revision,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1.0,
            )

            self.assertEqual(artifact.text, "Hello")
            self.assertTrue(store.audio_path(artifact.id).is_file())
            self.assertEqual(
                list((root / "recordings").glob("session-*")),
                [],
            )

    def test_stale_passage_revision_is_a_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary),
                passage_loader=lambda _: SimpleNamespace(
                    revision=2,
                    intended_text="Thank",
                ),
                synthesizer=FakeSynthesizer(),
            )
            with self.assertRaises(ReferenceSpeechRevisionConflict):
                store.create(
                    passage_id="passage-11111111111111111111111111111111",
                    passage_revision=1,
                    scope=ReferenceSpeechScope(kind="passage"),
                    voice_identifier="af_heart",
                    speed=1.0,
                )

    def test_default_cache_bound_is_256_mib(self) -> None:
        self.assertEqual(DEFAULT_REFERENCE_SPEECH_CACHE_BYTES, 256 * 1024 * 1024)

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
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )

            self.assertTrue(store.prewarm())
            self.assertEqual(synth.prewarm_calls, 1)
            self.assertFalse((root / "artifacts").exists())

    def test_cached_artifact_remains_available_while_model_prewarm_is_blocked(
        self,
    ) -> None:
        prewarm_started = threading.Event()
        release_prewarm = threading.Event()

        class BlockingPrewarmSynthesizer(FakeSynthesizer):
            def prewarm(self):
                self.prewarm_calls += 1
                prewarm_started.set()
                if not release_prewarm.wait(timeout=1):
                    raise AssertionError("prewarm was not released")
                return True

        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = BlockingPrewarmSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            first = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )

            with ThreadPoolExecutor(max_workers=2) as executor:
                prewarm_future = executor.submit(store.prewarm)
                self.assertTrue(prewarm_started.wait(timeout=1))
                cached_future = executor.submit(
                    store.create,
                    passage_id="session-20260727-010101-000001",
                    passage_revision=1,
                    scope=ReferenceSpeechScope(kind="passage"),
                    voice_identifier="af_heart",
                    speed=1,
                )
                try:
                    cached = cached_future.result(timeout=0.5)
                finally:
                    release_prewarm.set()
                self.assertTrue(prewarm_future.result(timeout=1))

            self.assertEqual(cached.id, first.id)
            self.assertTrue(cached.cache_hit)
            self.assertEqual(len(synth.calls), 1)

    def test_startup_prewarm_prunes_oldest_artifact_to_configured_bound(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            seed_store = ReferenceSpeechArtifactStore(
                root=root,
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=FakeSynthesizer(),
                cache_max_bytes=10_000_000,
            )
            oldest = seed_store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            newest = seed_store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1.1,
            )
            artifact_root = root / "artifacts"
            old_timestamp = 1_700_000_000
            for suffix in (".json", ".wav"):
                os.utime(
                    artifact_root / f"{oldest.id}{suffix}",
                    (old_timestamp, old_timestamp),
                )
            newest_size = sum(
                (artifact_root / f"{newest.id}{suffix}").stat().st_size
                for suffix in (".json", ".wav")
            )
            store = ReferenceSpeechArtifactStore(
                root=root,
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=FakeSynthesizer(),
                cache_max_bytes=newest_size,
            )

            store.prewarm()

            with self.assertRaisesRegex(
                ReferenceSpeechError,
                "artifact not found",
            ):
                store.audio_path(oldest.id)
            self.assertTrue(store.audio_path(newest.id).is_file())
            self.assertLessEqual(store.state()["cacheBytes"], newest_size)

    def test_new_artifact_evicts_the_oldest_accessed_pair(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            seed_store = ReferenceSpeechArtifactStore(
                root=root,
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=FakeSynthesizer(),
                cache_max_bytes=10_000_000,
            )
            oldest = seed_store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            artifact_root = root / "artifacts"
            oldest_size = sum(
                (artifact_root / f"{oldest.id}{suffix}").stat().st_size
                for suffix in (".json", ".wav")
            )
            old_timestamp = 1_700_000_000
            for suffix in (".json", ".wav"):
                os.utime(
                    artifact_root / f"{oldest.id}{suffix}",
                    (old_timestamp, old_timestamp),
                )
            store = ReferenceSpeechArtifactStore(
                root=root,
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=FakeSynthesizer(),
                cache_max_bytes=oldest_size + 100,
            )

            newest = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1.1,
            )

            with self.assertRaisesRegex(
                ReferenceSpeechError,
                "artifact not found",
            ):
                store.audio_path(oldest.id)
            self.assertTrue(store.audio_path(newest.id).is_file())
            self.assertLessEqual(store.state()["cacheBytes"], oldest_size + 100)

    def test_audio_lease_defers_eviction_until_the_response_releases_it(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            seed_store = ReferenceSpeechArtifactStore(
                root=root,
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=FakeSynthesizer(),
                cache_max_bytes=10_000_000,
            )
            oldest = seed_store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            artifact_root = root / "artifacts"
            oldest_size = sum(
                (artifact_root / f"{oldest.id}{suffix}").stat().st_size
                for suffix in (".json", ".wav")
            )
            store = ReferenceSpeechArtifactStore(
                root=root,
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=FakeSynthesizer(),
                cache_max_bytes=oldest_size + 100,
            )
            lease = store.lease_audio(oldest.id)
            old_timestamp = 1_700_000_000
            for suffix in (".json", ".wav"):
                os.utime(
                    artifact_root / f"{oldest.id}{suffix}",
                    (old_timestamp, old_timestamp),
                )

            newest = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1.1,
            )

            self.assertTrue(lease.path.is_file())
            self.assertTrue(store.audio_path(newest.id).is_file())
            self.assertGreater(store.state()["cacheBytes"], oldest_size + 100)
            lease.release()
            with self.assertRaisesRegex(
                ReferenceSpeechError,
                "artifact not found",
            ):
                store.audio_path(oldest.id)
            self.assertLessEqual(store.state()["cacheBytes"], oldest_size + 100)

    def test_startup_prewarm_removes_orphan_and_temporary_cache_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            artifact_root = root / "artifacts"
            artifact_root.mkdir(parents=True)
            orphan_id = "a" * 64
            (artifact_root / f"{orphan_id}.wav").write_bytes(b"orphan")
            (artifact_root / ".partial-reference.wav").write_bytes(b"partial")
            (artifact_root / "unexpected.txt").write_text(
                "unexpected",
                encoding="utf-8",
            )
            store = ReferenceSpeechArtifactStore(
                root=root,
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=FakeSynthesizer(),
                cache_max_bytes=10_000_000,
            )

            store.prewarm()

            self.assertEqual(list(artifact_root.iterdir()), [])

    def test_artifact_larger_than_cache_limit_fails_without_leaving_files(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            store = ReferenceSpeechArtifactStore(
                root=root,
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=FakeSynthesizer(),
                cache_max_bytes=1,
            )

            with self.assertRaisesRegex(
                ReferenceSpeechSynthesisError,
                "exceeds the reference-speech cache limit",
            ):
                store.create(
                    passage_id="session-20260727-010101-000001",
                    passage_revision=1,
                    scope=ReferenceSpeechScope(kind="passage"),
                    voice_identifier="af_heart",
                    speed=1,
                )

            self.assertEqual(list((root / "artifacts").iterdir()), [])

    def test_passage_uses_direct_cmu_ipa_and_reuses_atomic_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Think, thank."),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            first = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=0.85,
            )
            second = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
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
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Think thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            think = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="word", index=0),
                voice_identifier="af_heart",
                speed=1,
            )
            thank = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="word", index=1),
                voice_identifier="af_heart",
                speed=1,
            )
            faster = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="word", index=1),
                voice_identifier="af_heart",
                speed=1.1,
            )
            self.assertEqual((think.ipa, thank.ipa), ("θˈɪŋk", "θˈæŋk"))
            self.assertNotEqual(think.id, thank.id)
            self.assertNotEqual(thank.id, faster.id)

    def test_intended_text_revision_changes_reference_artifact_identity(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            passage = SimpleNamespace(
                revision=1,
                intended_text="Hello. How would you?",
            )
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                passage_loader=lambda _: passage,
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            original = store.create(
                passage_id=f"passage-{'1' * 32}",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )

            passage.revision = 2
            passage.intended_text = "Hello. How are you?"
            corrected = store.create(
                passage_id=f"passage-{'1' * 32}",
                passage_revision=2,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )

            self.assertNotEqual(original.id, corrected.id)
            self.assertNotEqual(original.ipa, corrected.ipa)
            self.assertEqual(len(synth.calls), 2)

    def test_unknown_word_fails_without_calling_synthesizer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            synth = FakeSynthesizer()
            store = ReferenceSpeechArtifactStore(
                root=Path(temporary_directory),
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="xyzzynotaword"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            with self.assertRaisesRegex(
                ReferenceSpeechError,
                "CMUdict has no pronunciation",
            ):
                store.create(
                    passage_id="session-20260727-010101-000001",
                    passage_revision=1,
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
                passage_loader=lambda _: SimpleNamespace(
                    revision=1,
                    intended_text="Choose auto-ACS.",
                ),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            artifact = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
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
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            artifact = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            store.audio_path(artifact.id).with_suffix(".json").write_text(
                "{}",
                encoding="utf-8",
            )
            replaced = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
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
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )
            artifact = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
                scope=ReferenceSpeechScope(kind="passage"),
                voice_identifier="af_heart",
                speed=1,
            )
            store.audio_path(artifact.id).write_bytes(b"corrupt")
            replaced = store.create(
                passage_id="session-20260727-010101-000001",
                passage_revision=1,
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
                passage_loader=lambda _: SimpleNamespace(revision=1, intended_text="Thank"),
                synthesizer=synth,
                cache_max_bytes=10_000_000,
            )

            def create():
                return store.create(
                    passage_id="session-20260727-010101-000001",
                    passage_revision=1,
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
