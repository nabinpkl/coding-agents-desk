"""Host-owned practice passages and their immutable recording attempts."""

from __future__ import annotations

import json
import os
import re
import threading
import unicodedata
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final
from uuid import NAMESPACE_URL, uuid4, uuid5

from interaction_agent.paths import VOICE_RECORDING_ROOT
from interaction_agent.voice.recording import timestamp_in_utc
from interaction_agent.voice.reference_pronunciation import (
    ReferencePronunciationError,
    reference_pronunciation,
)
from interaction_agent.voice.wire import (
    PracticePassage,
    PracticePassageReference,
    PracticePassageReferenceWord,
    Recording,
)

PASSAGE_SCHEMA_VERSION: Final = 1
RECORDING_SCHEMA_VERSION: Final = 4
MAXIMUM_INTENDED_TEXT_CHARACTERS: Final = 4_000
DEFAULT_PAGE_LIMIT: Final = 50
MAXIMUM_PAGE_LIMIT: Final = 100

PASSAGE_ID_PATTERN: Final = re.compile(r"^passage-[0-9a-f]{32}$")
RECORDING_ID_PATTERN: Final = re.compile(r"^session-\d{8}-\d{6}-\d{6}$")

_PASSAGE_LOCK = threading.RLock()


class PracticePassageError(ValueError):
    """A passage request violated the persisted practice contract."""


class PassageRevisionConflict(PracticePassageError):
    def __init__(self, expected: int, actual: int) -> None:
        super().__init__(
            f"Practice passage changed: expected revision {expected}, "
            f"current revision is {actual}"
        )
        self.expected = expected
        self.actual = actual


class PracticePassageStore:
    """Own passage metadata while recording sidecars own attempt evidence."""

    def __init__(self, recording_root: Path | None = None) -> None:
        self._recording_root = recording_root or VOICE_RECORDING_ROOT
        self._passage_root = self._recording_root / "passages"

    def migrate_legacy_recordings(
        self,
        *,
        recover_unattached_current: bool = False,
    ) -> None:
        """Give every pre-passage recording one deterministic passage.

        A schema-4 recording with no passage is the normal private staging
        state between WAV persistence and finalization. Live list reads leave
        it alone. Startup recovery opts in because no capture can still own it.
        """
        with _PASSAGE_LOCK:
            for metadata_path in self._recording_metadata_paths():
                payload = self._read_json(metadata_path)
                machine_transcript = self._machine_transcript(payload) or ""
                changed = self._upgrade_transcription(payload)
                passage_id = payload.get("passageID")
                if isinstance(passage_id, str) and PASSAGE_ID_PATTERN.fullmatch(
                    passage_id
                ):
                    if payload.get("schemaVersion") != RECORDING_SCHEMA_VERSION:
                        payload["schemaVersion"] = RECORDING_SCHEMA_VERSION
                        changed = True
                    if changed:
                        self._write_json(metadata_path, payload)
                    continue
                if (
                    payload.get("schemaVersion") == RECORDING_SCHEMA_VERSION
                    and not recover_unattached_current
                ):
                    continue

                recording_id = metadata_path.stem
                passage_id = self._legacy_passage_id(recording_id)
                passage_path = self._passage_path(passage_id)
                if not passage_path.exists():
                    created_at = str(
                        payload.get("createdAt") or datetime.now(UTC).isoformat()
                    )
                    self._write_json(
                        passage_path,
                        self._new_passage_payload(
                            passage_id,
                            intended_text=machine_transcript,
                            created_at=created_at,
                            baseline_recording_id=(
                                recording_id
                                if payload.get("status", "completed") == "completed"
                                else None
                            ),
                        ),
                    )
                payload["schemaVersion"] = RECORDING_SCHEMA_VERSION
                payload["passageID"] = passage_id
                self._write_json(metadata_path, payload)

    def create_passage(self, intended_text: str) -> PracticePassage:
        """Create human-owned practice intent without fabricating an attempt."""
        normalized = self._normalize_intended_text(intended_text)
        with _PASSAGE_LOCK:
            passage_id = self._new_passage_id()
            created_at = datetime.now(UTC).isoformat()
            payload = self._new_passage_payload(
                passage_id,
                intended_text=normalized,
                created_at=created_at,
                baseline_recording_id=None,
            )
            self._write_json(self._passage_path(passage_id), payload)
            return self._passage_from_payload(payload)

    def attach_recording(
        self,
        recording_id: str,
        *,
        passage_id: str | None,
        machine_transcript: str | None,
    ) -> PracticePassage:
        """Attach a finalized attempt or create its new free-form passage."""
        recording_path = self._recording_path(recording_id)
        with _PASSAGE_LOCK:
            recording_payload = self._read_json(recording_path)
            created_new_passage = passage_id is None
            if passage_id is None:
                passage_id = self._new_passage_id()
                created_at = str(
                    recording_payload.get("createdAt")
                    or datetime.now(UTC).isoformat()
                )
                passage_payload = self._new_passage_payload(
                    passage_id,
                    intended_text=machine_transcript or "",
                    created_at=created_at,
                    baseline_recording_id=(
                        recording_id
                        if recording_payload.get("status", "completed")
                        == "completed"
                        else None
                    ),
                )
                self._write_json(
                    self._passage_path(passage_id),
                    passage_payload,
                )
            else:
                passage_payload = self._load_passage_payload(passage_id)

            try:
                recording_payload["schemaVersion"] = RECORDING_SCHEMA_VERSION
                recording_payload["passageID"] = passage_id
                self._write_json(recording_path, recording_payload)
            except Exception:
                if created_new_passage:
                    self._passage_path(passage_id).unlink(missing_ok=True)
                raise

            if not created_new_passage:
                if (
                    passage_payload.get("baselineRecordingID") is None
                    and recording_payload.get("status", "completed") == "completed"
                ):
                    passage_payload["baselineRecordingID"] = recording_id
                self._touch_passage(passage_payload)
                self._write_json(
                    self._passage_path(passage_id),
                    passage_payload,
                )
            return self._passage_from_payload(passage_payload)

    def list_passages(
        self,
        *,
        limit: int = DEFAULT_PAGE_LIMIT,
        cursor: str | None = None,
    ) -> tuple[list[PracticePassage], str | None]:
        """Return newest-active passages with an opaque continuation cursor."""
        normalized_limit = self._validate_limit(limit)
        self.migrate_legacy_recordings()
        with _PASSAGE_LOCK:
            passages = [
                self._passage_from_payload(self._read_json(path))
                for path in self._passage_metadata_paths()
            ]
        passages.sort(
            key=lambda passage: (
                timestamp_in_utc(passage.updated_at),
                passage.id,
            ),
            reverse=True,
        )
        page, next_cursor = self._page_after(
            passages,
            cursor=cursor,
            limit=normalized_limit,
        )
        return page, next_cursor

    def get_passage(self, passage_id: str) -> PracticePassage:
        with _PASSAGE_LOCK:
            return self._passage_from_payload(
                self._load_passage_payload(passage_id)
            )

    def get_reference(
        self,
        passage_id: str,
        *,
        expected_revision: int,
    ) -> PracticePassageReference:
        """Derive display phones from the current intended-text revision."""
        with _PASSAGE_LOCK:
            payload = self._load_passage_payload(passage_id)
            self._require_revision(payload, expected_revision)
            try:
                pronunciation = reference_pronunciation(
                    str(payload["intendedText"])
                )
            except ReferencePronunciationError as exc:
                return PracticePassageReference(
                    passage_id=passage_id,
                    passage_revision=int(payload["revision"]),
                    words=[],
                    unknown_words=[],
                    pronunciation_error=str(exc),
                )
            return PracticePassageReference(
                passage_id=passage_id,
                passage_revision=int(payload["revision"]),
                words=[
                    PracticePassageReferenceWord(
                        word=word.word,
                        reference_phones=list(word.display_phones),
                        has_reference_pronunciation=word.is_known,
                    )
                    for word in pronunciation.words
                ],
                unknown_words=list(pronunciation.unknown_words),
                dictionary_identifier=pronunciation.dictionary_identifier,
                dictionary_hash=pronunciation.dictionary_hash,
            )

    def list_attempts(
        self,
        passage_id: str,
        *,
        limit: int = DEFAULT_PAGE_LIMIT,
        cursor: str | None = None,
    ) -> tuple[PracticePassage, list[Recording], str | None]:
        normalized_limit = self._validate_limit(limit)
        from interaction_agent.voice.web_stream import load_recording

        with _PASSAGE_LOCK:
            passage = self._passage_from_payload(
                self._load_passage_payload(passage_id)
            )
            attempts = [
                load_recording(recording_id)
                for recording_id in self._attempt_ids(passage_id)
            ]
            attempts.sort(
                key=lambda attempt: (
                    timestamp_in_utc(attempt.created_at),
                    attempt.id,
                ),
                reverse=True,
            )
            page, next_cursor = self._page_after(
                attempts,
                cursor=cursor,
                limit=normalized_limit,
            )
            return passage, page, next_cursor

    def update_intended_text(
        self,
        passage_id: str,
        *,
        expected_revision: int,
        intended_text: str,
    ) -> PracticePassage:
        normalized = self._normalize_intended_text(intended_text)
        with _PASSAGE_LOCK:
            payload = self._load_passage_payload(passage_id)
            self._require_revision(payload, expected_revision)
            payload["intendedText"] = normalized
            self._touch_passage(payload)
            self._write_json(self._passage_path(passage_id), payload)
            return self._passage_from_payload(payload)

    def update_baseline(
        self,
        passage_id: str,
        *,
        expected_revision: int,
        recording_id: str | None,
    ) -> PracticePassage:
        with _PASSAGE_LOCK:
            payload = self._load_passage_payload(passage_id)
            self._require_revision(payload, expected_revision)
            if (
                recording_id is not None
                and recording_id not in self._attempt_ids(passage_id)
            ):
                raise PracticePassageError(
                    "Baseline recording does not belong to this passage"
                )
            payload["baselineRecordingID"] = recording_id
            self._touch_passage(payload)
            self._write_json(self._passage_path(passage_id), payload)
            return self._passage_from_payload(payload)

    def delete_attempt(
        self,
        passage_id: str,
        recording_id: str,
    ) -> PracticePassage | None:
        with _PASSAGE_LOCK:
            passage_payload = self._load_passage_payload(passage_id)
            recording_path = self._recording_path(recording_id)
            if not recording_path.exists():
                return False
            recording_payload = self._read_json(recording_path)
            if recording_payload.get("passageID") != passage_id:
                raise PracticePassageError(
                    "Recording does not belong to this passage"
                )
            moved: list[tuple[Path, Path]] = []
            try:
                # Metadata is the visibility/ownership record, so move it out
                # first. A synchronous failure restores every prior move and
                # never leaves a visible attempt whose WAV disappeared.
                self._stage_delete(recording_path, moved)
                wav_path = self._recording_root / f"{recording_id}.wav"
                if wav_path.exists():
                    self._stage_delete(wav_path, moved)
                if passage_payload.get("baselineRecordingID") == recording_id:
                    passage_payload["baselineRecordingID"] = None
                self._touch_passage(passage_payload)
                self._write_json(
                    self._passage_path(passage_id),
                    passage_payload,
                )
            except Exception:
                self._restore_staged_deletes(moved)
                raise
            self._commit_staged_deletes(moved)
            return self._passage_from_payload(passage_payload)

    def delete_passage(self, passage_id: str) -> int:
        with _PASSAGE_LOCK:
            self._load_passage_payload(passage_id)
            attempt_ids = self._attempt_ids(passage_id)
            moved: list[tuple[Path, Path]] = []
            try:
                self._stage_delete(self._passage_path(passage_id), moved)
                for recording_id in attempt_ids:
                    self._stage_delete(
                        self._recording_path(recording_id),
                        moved,
                    )
                    wav_path = self._recording_root / f"{recording_id}.wav"
                    if wav_path.exists():
                        self._stage_delete(wav_path, moved)
            except Exception:
                self._restore_staged_deletes(moved)
                raise
            self._commit_staged_deletes(moved)
            return len(attempt_ids)

    def _passage_from_payload(
        self,
        payload: dict[str, Any],
    ) -> PracticePassage:
        passage_id = str(payload["id"])
        attempt_ids = self._attempt_ids(passage_id)
        attempts = [
            self._read_json(self._recording_path(recording_id))
            for recording_id in attempt_ids
        ]
        latest = max(
            (str(attempt.get("createdAt", "")) for attempt in attempts),
            key=timestamp_in_utc,
            default=None,
        )
        baseline = payload.get("baselineRecordingID")
        if baseline is not None and baseline not in set(attempt_ids):
            baseline = None
        return PracticePassage(
            id=passage_id,
            intended_text=str(payload.get("intendedText", "")),
            revision=int(payload["revision"]),
            created_at=str(payload["createdAt"]),
            updated_at=str(payload["updatedAt"]),
            baseline_recording_id=baseline,
            attempt_count=len(attempts),
            latest_attempt_created_at=latest,
        )

    def _attempt_ids(self, passage_id: str) -> list[str]:
        return [
            path.stem
            for path in self._recording_metadata_paths()
            if self._read_json(path).get("passageID") == passage_id
        ]

    def _load_passage_payload(self, passage_id: str) -> dict[str, Any]:
        path = self._passage_path(passage_id)
        if not path.exists():
            raise FileNotFoundError(f"practice passage not found: {passage_id}")
        payload = self._read_json(path)
        if payload.get("schemaVersion") != PASSAGE_SCHEMA_VERSION:
            raise PracticePassageError(
                f"Unsupported practice passage schema: "
                f"{payload.get('schemaVersion')}"
            )
        return payload

    def _new_passage_payload(
        self,
        passage_id: str,
        *,
        intended_text: str,
        created_at: str,
        baseline_recording_id: str | None,
    ) -> dict[str, Any]:
        normalized = unicodedata.normalize("NFC", intended_text).strip()
        if len(normalized) > MAXIMUM_INTENDED_TEXT_CHARACTERS:
            raise PracticePassageError(
                "Intended text exceeds the 4000 character limit"
            )
        return {
            "schemaVersion": PASSAGE_SCHEMA_VERSION,
            "id": passage_id,
            "intendedText": normalized,
            "revision": 1,
            "createdAt": created_at,
            "updatedAt": created_at,
            "baselineRecordingID": baseline_recording_id,
        }

    @staticmethod
    def _touch_passage(payload: dict[str, Any]) -> None:
        payload["revision"] = int(payload["revision"]) + 1
        payload["updatedAt"] = datetime.now(UTC).isoformat()

    @staticmethod
    def _require_revision(
        payload: dict[str, Any],
        expected_revision: int,
    ) -> None:
        actual = int(payload["revision"])
        if actual != expected_revision:
            raise PassageRevisionConflict(expected_revision, actual)

    @staticmethod
    def _normalize_intended_text(value: str) -> str:
        normalized = unicodedata.normalize("NFC", value).strip()
        if not normalized:
            raise PracticePassageError("Intended text cannot be empty")
        if len(normalized) > MAXIMUM_INTENDED_TEXT_CHARACTERS:
            raise PracticePassageError(
                "Intended text exceeds the 4000 character limit"
            )
        return normalized

    @staticmethod
    def _machine_transcript(payload: dict[str, Any]) -> str | None:
        transcription = payload.get("transcription")
        if isinstance(transcription, dict):
            text = transcription.get("text")
            return text if isinstance(text, str) else None
        legacy = payload.get("transcript")
        if isinstance(legacy, dict):
            text = legacy.get("text")
            return text if isinstance(text, str) else None
        return None

    @staticmethod
    def _upgrade_transcription(payload: dict[str, Any]) -> bool:
        if "transcript" not in payload:
            return False
        legacy = payload.pop("transcript")
        if "transcription" not in payload and isinstance(legacy, dict):
            payload["transcription"] = legacy
        return True

    def _recording_metadata_paths(self) -> list[Path]:
        if not self._recording_root.exists():
            return []
        return sorted(
            path
            for path in self._recording_root.glob("session-*.json")
            if RECORDING_ID_PATTERN.fullmatch(path.stem)
        )

    def _passage_metadata_paths(self) -> list[Path]:
        if not self._passage_root.exists():
            return []
        return sorted(
            path
            for path in self._passage_root.glob("passage-*.json")
            if PASSAGE_ID_PATTERN.fullmatch(path.stem)
        )

    def _passage_path(self, passage_id: str) -> Path:
        if not PASSAGE_ID_PATTERN.fullmatch(passage_id):
            raise PracticePassageError(
                f"Invalid practice passage id: {passage_id!r}"
            )
        return self._passage_root / f"{passage_id}.json"

    def _recording_path(self, recording_id: str) -> Path:
        if not RECORDING_ID_PATTERN.fullmatch(recording_id):
            raise PracticePassageError(
                f"Invalid recording id: {recording_id!r}"
            )
        return self._recording_root / f"{recording_id}.json"

    @staticmethod
    def _new_passage_id() -> str:
        return f"passage-{uuid4().hex}"

    @staticmethod
    def _legacy_passage_id(recording_id: str) -> str:
        return f"passage-{uuid5(NAMESPACE_URL, recording_id).hex}"

    @staticmethod
    def _validate_limit(limit: int) -> int:
        if limit < 1 or limit > MAXIMUM_PAGE_LIMIT:
            raise PracticePassageError(
                f"Page limit must be between 1 and {MAXIMUM_PAGE_LIMIT}"
            )
        return limit

    @staticmethod
    def _page_after(
        values: list[Any],
        *,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[Any], str | None]:
        start = 0
        if cursor is not None:
            try:
                start = next(
                    index + 1
                    for index, value in enumerate(values)
                    if value.id == cursor
                )
            except StopIteration as exc:
                raise PracticePassageError("Pagination cursor is stale") from exc
        page = values[start : start + limit]
        next_cursor = (
            page[-1].id if start + len(page) < len(values) and page else None
        )
        return page, next_cursor

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise PracticePassageError(f"Invalid metadata document: {path}")
        return payload

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)

    @staticmethod
    def _stage_delete(
        path: Path,
        moved: list[tuple[Path, Path]],
    ) -> None:
        staged = path.with_name(f".{path.name}.deleting-{uuid4().hex}")
        os.replace(path, staged)
        moved.append((path, staged))

    @staticmethod
    def _restore_staged_deletes(
        moved: list[tuple[Path, Path]],
    ) -> None:
        rollback_error: Exception | None = None
        for original, staged in reversed(moved):
            try:
                if staged.exists():
                    os.replace(staged, original)
            except Exception as exc:  # pragma: no cover - catastrophic FS error
                rollback_error = rollback_error or exc
        if rollback_error is not None:
            raise PracticePassageError(
                f"Failed to roll back passage deletion: {rollback_error}"
            ) from rollback_error

    @staticmethod
    def _commit_staged_deletes(
        moved: list[tuple[Path, Path]],
    ) -> None:
        for _, staged in moved:
            staged.unlink(missing_ok=True)
