from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import ExitStack
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import numpy as np

from interaction_agent.voice import practice_passages, recording, web_stream
from interaction_agent.voice.practice_passages import (
    PassageRevisionConflict,
    PracticePassageError,
    PracticePassageStore,
)


class PracticePassageStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.stack = ExitStack()
        for module in (practice_passages, recording, web_stream):
            self.stack.enter_context(
                patch.object(module, "VOICE_RECORDING_ROOT", self.root)
            )
        self.store = PracticePassageStore(self.root)

    def tearDown(self) -> None:
        self.stack.close()
        self.temporary.cleanup()

    def save_recording(
        self,
        transcript: str,
        *,
        status: str = "completed",
        started_at: datetime | None = None,
        attach: bool = True,
    ) -> str:
        result = recording.save_voice_recording(
            np.full(2_048, 0.1, dtype=np.float32),
            16_000,
            started_at or datetime(2026, 7, 30, tzinfo=UTC),
            status=status,
        )
        recording.save_voice_recording_transcript(result, transcript)
        if attach:
            self.store.attach_recording(
                result.wav_path.stem,
                passage_id=None,
                machine_transcript=transcript,
            )
        return result.wav_path.stem

    def test_typed_reference_creates_persistent_zero_attempt_passage(
        self,
    ) -> None:
        first = self.store.create_passage("  Cafe\u0301 practice  ")
        second = self.store.create_passage("Café practice")

        self.assertNotEqual(first.id, second.id)
        self.assertEqual(first.intended_text, "Café practice")
        self.assertEqual(first.revision, 1)
        self.assertEqual(first.attempt_count, 0)
        self.assertIsNone(first.baseline_recording_id)
        self.assertIsNone(first.latest_attempt_created_at)
        self.assertEqual(list(self.root.glob("session-*.json")), [])
        self.assertEqual(list(self.root.glob("session-*.wav")), [])

        restored = PracticePassageStore(self.root).get_passage(first.id)
        self.assertEqual(restored, first)

        with self.assertRaisesRegex(
            PracticePassageError,
            "cannot be empty",
        ):
            self.store.create_passage(" \n ")
        with self.assertRaisesRegex(
            PracticePassageError,
            "4000 character",
        ):
            self.store.create_passage("x" * 4_001)

    def test_zero_attempt_reference_is_revision_fenced(self) -> None:
        passage = self.store.create_passage("Hello quuxword")

        reference = self.store.get_reference(
            passage.id,
            expected_revision=passage.revision,
        )

        self.assertEqual(reference.passage_id, passage.id)
        self.assertEqual(reference.passage_revision, passage.revision)
        self.assertEqual(
            [word.word for word in reference.words],
            ["hello", "quuxword"],
        )
        self.assertEqual(
            reference.words[0].reference_phones,
            ["h", "ə", "l", "oʊ"],
        )
        self.assertTrue(reference.words[0].has_reference_pronunciation)
        self.assertFalse(reference.words[1].has_reference_pronunciation)
        self.assertEqual(reference.unknown_words, ["quuxword"])
        self.assertIsNone(reference.pronunciation_error)
        self.assertTrue(reference.dictionary_identifier.startswith("CMUdict@"))

        updated = self.store.update_intended_text(
            passage.id,
            expected_revision=passage.revision,
            intended_text="Hello again",
        )
        self.assertEqual(updated.revision, passage.revision + 1)
        with self.assertRaises(PassageRevisionConflict):
            self.store.get_reference(
                passage.id,
                expected_revision=passage.revision,
            )

    def test_legacy_recording_migrates_to_one_human_owned_passage(self) -> None:
        recording_id = self.save_recording(
            "Hello. How would you?",
            attach=False,
        )
        metadata_path = web_stream.recording_json_path(recording_id)
        legacy_payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        legacy_payload["schemaVersion"] = 3
        legacy_payload["transcript"] = legacy_payload.pop("transcription")
        legacy_payload.pop("passageID")
        metadata_path.write_text(
            json.dumps(legacy_payload),
            encoding="utf-8",
        )

        passages, cursor = self.store.list_passages()
        migrated = web_stream.load_recording(recording_id)
        upgraded_payload = json.loads(
            metadata_path.read_text(encoding="utf-8")
        )

        self.assertEqual(len(passages), 1)
        self.assertIsNone(cursor)
        self.assertEqual(passages[0].intended_text, "Hello. How would you?")
        self.assertEqual(passages[0].attempt_count, 1)
        self.assertEqual(migrated.machine_transcript, "Hello. How would you?")
        self.assertEqual(migrated.intended_text, "Hello. How would you?")
        self.assertEqual(migrated.passage_id, passages[0].id)
        self.assertEqual(upgraded_payload["schemaVersion"], 4)
        self.assertNotIn("transcript", upgraded_payload)
        self.assertEqual(
            upgraded_payload["transcription"]["text"],
            "Hello. How would you?",
        )
        self.assertEqual(
            self.store.list_passages()[0][0].id,
            passages[0].id,
        )

    def test_intended_text_edit_preserves_attempt_evidence(self) -> None:
        recording_id = self.save_recording("Hello. How would you?")
        passage = self.store.list_passages()[0][0]
        before = json.loads(
            web_stream.recording_json_path(recording_id).read_text(
                encoding="utf-8"
            )
        )
        before_metadata_bytes = web_stream.recording_json_path(
            recording_id
        ).read_bytes()
        before_wav_bytes = web_stream.recording_wav_path(
            recording_id
        ).read_bytes()

        updated = self.store.update_intended_text(
            passage.id,
            expected_revision=passage.revision,
            intended_text="Hello. How are you?",
        )
        after = json.loads(
            web_stream.recording_json_path(recording_id).read_text(
                encoding="utf-8"
            )
        )
        attempt = web_stream.load_recording(recording_id)

        self.assertEqual(updated.revision, passage.revision + 1)
        self.assertEqual(updated.intended_text, "Hello. How are you?")
        self.assertEqual(before["transcription"], after["transcription"])
        self.assertEqual(before["summary"], after["summary"])
        self.assertEqual(
            web_stream.recording_json_path(recording_id).read_bytes(),
            before_metadata_bytes,
        )
        self.assertEqual(
            web_stream.recording_wav_path(recording_id).read_bytes(),
            before_wav_bytes,
        )
        self.assertEqual(
            attempt.machine_transcript,
            "Hello. How would you?",
        )
        self.assertEqual(attempt.intended_text, "Hello. How are you?")
        self.assertEqual(
            [group.word for group in attempt.word_phone_groups],
            ["hello", "how", "are", "you"],
        )

    def test_stale_intended_text_edit_is_rejected(self) -> None:
        self.save_recording("Hello")
        passage = self.store.list_passages()[0][0]
        self.store.update_intended_text(
            passage.id,
            expected_revision=passage.revision,
            intended_text="Hello there",
        )

        with self.assertRaises(PassageRevisionConflict):
            self.store.update_intended_text(
                passage.id,
                expected_revision=passage.revision,
                intended_text="Stale edit",
            )

    def test_text_and_baseline_invariants_are_enforced(self) -> None:
        recording_id = self.save_recording("Hello")
        passage = self.store.list_passages()[0][0]

        updated = self.store.update_intended_text(
            passage.id,
            expected_revision=passage.revision,
            intended_text="  Cafe\u0301  ",
        )
        self.assertEqual(updated.intended_text, "Café")

        with self.assertRaisesRegex(
            PracticePassageError,
            "cannot be empty",
        ):
            self.store.update_intended_text(
                passage.id,
                expected_revision=updated.revision,
                intended_text=" \n ",
            )
        with self.assertRaisesRegex(
            PracticePassageError,
            "4000 character",
        ):
            self.store.update_intended_text(
                passage.id,
                expected_revision=updated.revision,
                intended_text="x" * 4_001,
            )
        with self.assertRaisesRegex(
            PracticePassageError,
            "does not belong",
        ):
            self.store.update_baseline(
                passage.id,
                expected_revision=updated.revision,
                recording_id="session-20000101-000000-000000",
            )
        self.assertEqual(
            self.store.get_passage(passage.id).baseline_recording_id,
            recording_id,
        )

    def test_interrupted_attempt_without_transcript_is_retained(
        self,
    ) -> None:
        result = recording.save_voice_recording(
            np.full(2_048, 0.1, dtype=np.float32),
            16_000,
            datetime(2026, 7, 30, tzinfo=UTC),
            status="interrupted",
        )
        self.store.attach_recording(
            result.wav_path.stem,
            passage_id=None,
            machine_transcript=None,
        )

        passage = self.store.list_passages()[0][0]
        attempt = web_stream.load_recording(result.wav_path.stem)

        self.assertEqual(passage.intended_text, "")
        self.assertIsNone(passage.baseline_recording_id)
        self.assertEqual(passage.attempt_count, 1)
        self.assertEqual(attempt.status, "interrupted")
        self.assertIsNone(attempt.machine_transcript)

    def test_live_list_does_not_migrate_a_current_finalization_staging_record(
        self,
    ) -> None:
        result = recording.save_voice_recording(
            np.full(2_048, 0.1, dtype=np.float32),
            16_000,
            datetime(2026, 7, 30, tzinfo=UTC),
        )

        passages, _ = self.store.list_passages()
        self.assertEqual(passages, [])
        self.assertEqual(web_stream.load_all_recordings(), [])

        self.store.migrate_legacy_recordings(
            recover_unattached_current=True,
        )
        recovered = web_stream.load_recording(result.wav_path.stem)
        self.assertEqual(recovered.machine_transcript, None)
        self.assertEqual(recovered.intended_text, "")

    def test_retake_attaches_to_passage_and_first_completed_is_baseline(
        self,
    ) -> None:
        first_id = self.save_recording("Hello", status="completed")
        passage = self.store.list_passages()[0][0]
        second_id = self.save_recording(
            "Hello",
            status="completed",
            started_at=datetime(2026, 7, 30, 0, 1, tzinfo=UTC),
            attach=False,
        )
        self.store.attach_recording(
            second_id,
            passage_id=passage.id,
            machine_transcript="Hello",
        )

        refreshed = self.store.get_passage(passage.id)
        attempts_passage, attempts, cursor = self.store.list_attempts(
            passage.id,
            limit=20,
        )

        self.assertEqual(refreshed.attempt_count, 2)
        self.assertEqual(attempts_passage.revision, refreshed.revision)
        self.assertEqual(refreshed.baseline_recording_id, first_id)
        self.assertEqual([attempt.id for attempt in attempts], [second_id, first_id])
        self.assertIsNone(cursor)

    def test_attempt_and_passage_deletion_preserve_explicit_empty_passage(
        self,
    ) -> None:
        recording_id = self.save_recording("Hello")
        passage = self.store.list_passages()[0][0]

        updated = self.store.delete_attempt(passage.id, recording_id)
        self.assertIsNotNone(updated)
        self.assertEqual(updated.attempt_count, 0)
        self.assertIsNone(updated.baseline_recording_id)
        empty = self.store.get_passage(passage.id)
        self.assertEqual(empty.attempt_count, 0)
        self.assertIsNone(empty.baseline_recording_id)
        self.assertFalse(web_stream.recording_json_path(recording_id).exists())
        self.assertFalse(web_stream.recording_wav_path(recording_id).exists())

        self.assertEqual(self.store.delete_passage(passage.id), 0)
        with self.assertRaises(FileNotFoundError):
            self.store.get_passage(passage.id)

    def test_attempt_delete_rolls_back_when_staging_fails(self) -> None:
        recording_id = self.save_recording("Hello")
        passage = self.store.list_passages()[0][0]
        original_stage = self.store._stage_delete
        stage_count = 0

        def fail_second_stage(
            path: Path,
            moved: list[tuple[Path, Path]],
        ) -> None:
            nonlocal stage_count
            stage_count += 1
            if stage_count == 2:
                raise OSError("injected staging failure")
            original_stage(path, moved)

        with patch.object(self.store, "_stage_delete", fail_second_stage):
            with self.assertRaisesRegex(OSError, "injected staging failure"):
                self.store.delete_attempt(passage.id, recording_id)

        self.assertTrue(web_stream.recording_json_path(recording_id).exists())
        self.assertTrue(web_stream.recording_wav_path(recording_id).exists())
        self.assertEqual(
            self.store.get_passage(passage.id).baseline_recording_id,
            recording_id,
        )

    def test_passage_delete_rolls_back_all_attempts_when_staging_fails(
        self,
    ) -> None:
        first_id = self.save_recording("Hello")
        passage = self.store.list_passages()[0][0]
        second_id = self.save_recording(
            "Hello again",
            started_at=datetime(2026, 7, 30, 0, 1, tzinfo=UTC),
            attach=False,
        )
        self.store.attach_recording(
            second_id,
            passage_id=passage.id,
            machine_transcript="Hello again",
        )
        original_stage = self.store._stage_delete
        stage_count = 0

        def fail_third_stage(
            path: Path,
            moved: list[tuple[Path, Path]],
        ) -> None:
            nonlocal stage_count
            stage_count += 1
            if stage_count == 3:
                raise OSError("injected passage staging failure")
            original_stage(path, moved)

        with patch.object(self.store, "_stage_delete", fail_third_stage):
            with self.assertRaisesRegex(
                OSError,
                "injected passage staging failure",
            ):
                self.store.delete_passage(passage.id)

        self.assertEqual(self.store.get_passage(passage.id).attempt_count, 2)
        for recording_id in (first_id, second_id):
            self.assertTrue(web_stream.recording_json_path(recording_id).exists())
            self.assertTrue(web_stream.recording_wav_path(recording_id).exists())

    def test_bounded_attempt_pagination_rejects_stale_cursor(self) -> None:
        first_id = self.save_recording("One")
        passage = self.store.list_passages()[0][0]
        second_id = self.save_recording(
            "Two",
            started_at=datetime(2026, 7, 30, 0, 1, tzinfo=UTC),
            attach=False,
        )
        self.store.attach_recording(
            second_id,
            passage_id=passage.id,
            machine_transcript="Two",
        )

        _, first_page, cursor = self.store.list_attempts(
            passage.id,
            limit=1,
        )
        _, second_page, next_cursor = self.store.list_attempts(
            passage.id,
            limit=1,
            cursor=cursor,
        )

        self.assertEqual([item.id for item in first_page], [second_id])
        self.assertEqual(cursor, second_id)
        self.assertEqual([item.id for item in second_page], [first_id])
        self.assertIsNone(next_cursor)
        with self.assertRaisesRegex(PracticePassageError, "cursor is stale"):
            self.store.list_attempts(
                passage.id,
                limit=1,
                cursor="session-20000101-000000-000000",
            )


if __name__ == "__main__":
    unittest.main()
