"""Framework-free glue for the browser<->backend voice WebSocket and REST layer.

Pure helpers over the reusable voice modules: base64 PCM decoding, meter math,
recording id <-> filesystem mapping, and client message parsing against the
``wire.py`` Pydantic models. No ASR or signal logic is reimplemented here; this
only decodes frames and reads what ``recording.py`` already persisted.
"""

import base64
import json
import re
from pathlib import Path
from typing import Final

import numpy as np
from numpy.typing import NDArray
from pydantic import ValidationError

from interaction_agent.paths import VOICE_RECORDING_ROOT
from interaction_agent.voice.recording import VoiceRecordingResult
from interaction_agent.voice.reference_pronunciation import (
    ReferencePronunciationError,
    reference_alignment,
)
from interaction_agent.voice.wire import (
    AudioFrameMessage,
    Recording,
    SessionStartMessage,
    SessionStopMessage,
    WordPhoneGroup,
)

FloatArray = NDArray[np.float32]

ClientWireMessage = SessionStartMessage | AudioFrameMessage | SessionStopMessage

RECORDING_ID_PATTERN: Final = re.compile(r"^session-\d{8}-\d{6}-\d{6}$")


class VoiceWireError(ValueError):
    """A client frame was malformed or a recording id was not well-formed."""


def decode_pcm(pcm_base64: str, encoding: str, channels: int = 1) -> FloatArray:
    """Decode a base64 PCM payload into mono float32 samples in [-1, 1]."""
    if encoding not in ("int16", "float32"):
        raise VoiceWireError(f"unsupported PCM encoding: {encoding!r}")
    if channels != 1:
        # The buffer carries no channel layout, so interleaved audio would be
        # silently misread as mono at the wrong rate. Reject it instead.
        raise VoiceWireError(f"only mono PCM is supported, got {channels} channels")

    try:
        raw = base64.b64decode(pcm_base64, validate=True)
        if encoding == "int16":
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        else:
            samples = np.frombuffer(raw, dtype=np.float32)
    except ValueError as exc:
        raise VoiceWireError(f"malformed {encoding} PCM frame: {exc}") from exc

    return np.ascontiguousarray(samples, dtype=np.float32)


def compute_meter(samples: FloatArray) -> tuple[float, float]:
    """Return (rms, peak) for one audio frame."""
    if samples.size == 0:
        return 0.0, 0.0

    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    peak = float(np.max(np.abs(samples)))
    return rms, peak


def parse_client_message(raw: str) -> ClientWireMessage:
    """Parse and validate one client WebSocket text frame. Fails loud."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise VoiceWireError(f"client frame is not valid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise VoiceWireError("client frame must be a JSON object")

    kind = data.get("type")
    try:
        if kind == "sessionStart":
            return SessionStartMessage.model_validate(data)
        if kind == "audioFrame":
            return AudioFrameMessage.model_validate(data)
        if kind == "sessionStop":
            return SessionStopMessage.model_validate(data)
    except ValidationError as exc:
        raise VoiceWireError(f"invalid {kind} frame: {exc}") from exc

    raise VoiceWireError(f"unknown client message type: {kind!r}")


def recording_id_from_result(result: VoiceRecordingResult) -> str:
    """The stable public id for a persisted recording is its wav file stem."""
    return result.wav_path.stem


def _validate_recording_id(recording_id: str) -> str:
    if not RECORDING_ID_PATTERN.match(recording_id):
        raise VoiceWireError(f"invalid recording id: {recording_id!r}")
    return recording_id


def recording_wav_path(recording_id: str) -> Path:
    return VOICE_RECORDING_ROOT / f"{_validate_recording_id(recording_id)}.wav"


def recording_json_path(recording_id: str) -> Path:
    return VOICE_RECORDING_ROOT / f"{_validate_recording_id(recording_id)}.json"


def load_recording(recording_id: str) -> Recording:
    """Build a wire ``Recording`` from the sidecar JSON ``recording.py`` wrote."""
    json_path = recording_json_path(recording_id)
    if not json_path.exists():
        raise FileNotFoundError(f"recording not found: {recording_id}")

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    summary = payload["summary"]
    transcription = payload.get("transcription")
    legacy_transcript = payload.get("transcript")
    if isinstance(transcription, dict):
        transcript_text = transcription.get("text")
        transcription_error = transcription.get("error")
    else:
        transcript_text = (
            legacy_transcript.get("text")
            if isinstance(legacy_transcript, dict)
            else None
        )
        transcription_error = None
    phone_analysis = payload.get("phoneAnalysis")
    phone_analysis = phone_analysis if isinstance(phone_analysis, dict) else {}
    observed_phones = list(phone_analysis.get("phones") or [])
    word_phone_groups: list[WordPhoneGroup] = []
    unknown_reference_words: list[str] = []
    reference_pronunciation_error: str | None = None
    reference_dictionary_identifier: str | None = None
    reference_dictionary_hash: str | None = None
    if isinstance(transcript_text, str) and transcript_text.strip():
        try:
            alignment = reference_alignment(transcript_text, observed_phones)
            word_phone_groups = [
                WordPhoneGroup(
                    word=group.word,
                    heard_phones=list(group.heard_phones),
                    reference_phones=list(group.reference_phones),
                    has_reference_pronunciation=(
                        group.has_reference_pronunciation
                    ),
                )
                for group in alignment.groups
            ]
            unknown_reference_words = list(alignment.unknown_words)
            reference_dictionary_identifier = alignment.dictionary_identifier
            reference_dictionary_hash = alignment.dictionary_hash
        except ReferencePronunciationError as exc:
            reference_pronunciation_error = str(exc)
    elif observed_phones:
        word_phone_groups = [
            WordPhoneGroup(
                word=None,
                heard_phones=observed_phones,
                reference_phones=[],
                has_reference_pronunciation=False,
            )
        ]

    return Recording(
        id=recording_id,
        created_at=str(payload["createdAt"]),
        duration_seconds=float(summary["durationSeconds"]),
        source=payload.get("source", "browserDev"),
        status=payload.get("status", "completed"),
        transcript=transcript_text,
        transcription_error=transcription_error,
        observed_phones=observed_phones,
        phone_analysis_error=phone_analysis.get("error"),
        phone_model_identifier=phone_analysis.get("modelIdentifier"),
        phone_model_hash=phone_analysis.get("modelHash"),
        phone_runtime_identifier=phone_analysis.get("runtimeIdentifier"),
        phone_analyzed_at=phone_analysis.get("analyzedAt"),
        word_phone_groups=word_phone_groups,
        unknown_reference_words=unknown_reference_words,
        reference_pronunciation_error=reference_pronunciation_error,
        reference_dictionary_identifier=reference_dictionary_identifier,
        reference_dictionary_hash=reference_dictionary_hash,
        sample_rate=int(summary["sampleRate"]),
    )


def list_recording_ids() -> list[str]:
    if not VOICE_RECORDING_ROOT.exists():
        return []

    ids = [
        path.stem
        for path in VOICE_RECORDING_ROOT.glob("session-*.json")
        if RECORDING_ID_PATTERN.match(path.stem)
    ]
    return sorted(ids)


def load_all_recordings() -> list[Recording]:
    """Every persisted recording, newest first.

    Ordering is the server's call, not each client's: the list is what a user
    reads top-down and the newest take is the one they just made. Sorting on
    ``createdAt`` rather than the id keeps this honest if the id format ever
    stops being timestamp-ordered.
    """
    recordings = [load_recording(recording_id) for recording_id in list_recording_ids()]
    recordings.sort(key=lambda recording: recording.created_at, reverse=True)
    return recordings


def delete_recording(recording_id: str) -> bool:
    """Remove a recording's audio and metadata. False when it was not there.

    Both files go or neither does, so a half-deleted recording can never show up
    in the list with no audio behind it: the json is the one the list reads, so
    it is removed last.
    """
    wav_path = recording_wav_path(recording_id)
    json_path = recording_json_path(recording_id)
    if not json_path.exists():
        return False
    wav_path.unlink(missing_ok=True)
    json_path.unlink()
    return True
