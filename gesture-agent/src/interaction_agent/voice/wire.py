"""Single source of truth for the browser<->backend wire contract.

Every WebSocket message and REST payload exchanged between the Next.js frontend
and the FastAPI voice backend is declared here as a Pydantic model. JSON is
camelCase on the wire; Python fields stay snake_case and are aliased by
``to_camel``. The TypeScript mirror in ``web/src/lib/wire.ts`` is generated from
these models by ``just wire-gen`` (which runs ``python -m
interaction_agent.voice.wire``); never edit that file by hand.

The ``SignalAnalysis`` and ``PronunciationComparison`` models mirror the
``.to_json_payload()`` shapes of ``voice.signals`` and ``voice.pronunciation``
exactly, so a payload produced by those modules validates against these models.
"""

import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from pydantic.json_schema import models_json_schema

from interaction_agent.paths import PROJECT_ROOT

WIRE_TS_PATH: Final = PROJECT_ROOT / "web" / "src" / "lib" / "wire.ts"


class WireModel(BaseModel):
    """Base for every wire model: camelCase JSON aliases, strict payloads."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


# --- Client -> server WebSocket messages -----------------------------------


class SessionStartMessage(WireModel):
    type: Literal["sessionStart"] = "sessionStart"
    preamp_gain: float | None = None


class AudioFrameMessage(WireModel):
    type: Literal["audioFrame"] = "audioFrame"
    sequence: int = Field(ge=0)
    pcm: str
    """Base64-encoded PCM samples in the ``encoding`` below."""
    sample_count: int = Field(gt=0)
    sample_rate: int = Field(gt=0)
    encoding: Literal["int16", "float32"] = "int16"
    channels: int = 1
    """Interleaved channel count. Only mono (1) is accepted; the decoder rejects
    anything else rather than silently misreading interleaved samples."""


class SessionStopMessage(WireModel):
    type: Literal["sessionStop"] = "sessionStop"
    final_sequence: int = Field(ge=-1)
    captured_sample_count: int = Field(ge=0)


# --- Server -> client WebSocket messages -----------------------------------


class PartialTranscriptMessage(WireModel):
    type: Literal["partialTranscript"] = "partialTranscript"
    text: str


class FinalTranscriptMessage(WireModel):
    type: Literal["finalTranscript"] = "finalTranscript"
    text: str


class MeterMessage(WireModel):
    type: Literal["meter"] = "meter"
    rms: float
    peak: float


class SessionProgressMessage(WireModel):
    type: Literal["sessionProgress"] = "sessionProgress"
    stage: Literal["saving", "transcribing", "analyzing"]


class SessionErrorMessage(WireModel):
    type: Literal["sessionError"] = "sessionError"
    code: Literal[
        "recorderBusy",
        "invalidSession",
        "transcriptionFailed",
        "phoneAnalysisFailed",
        "transportLost",
    ]
    message: str


class SessionCompleteMessage(WireModel):
    type: Literal["sessionComplete"] = "sessionComplete"
    recording: "Recording"
    """Emitted only after the recording is fully persisted (momentum->truth)."""


# The gesture WebSocket protocol was retired once the swipe tracker moved
# client-side (the webview runs it locally). Its message models and the
# `/ws/gesture` route are gone; the gesture anchor is now a frontend-only shape
# defined in web/src/features/gesture/types.ts.


# --- REST record models ----------------------------------------------------


class WordPhoneGroup(WireModel):
    word: str | None
    heard_phones: list[str]
    reference_phones: list[str]
    has_reference_pronunciation: bool


class RecordingTransportAudit(WireModel):
    protocol_identifier: Literal["voice-audio-v2"]
    continuity_status: Literal["complete", "interrupted"]
    received_frame_count: int = Field(ge=0)
    received_sample_count: int = Field(ge=0)
    received_final_sequence: int = Field(ge=-1)
    client_final_sequence: int | None = Field(default=None, ge=-1)
    client_captured_sample_count: int | None = Field(default=None, ge=0)
    first_frame_received_at: str | None = None
    last_frame_received_at: str | None = None
    stop_received_at: str | None = None
    interruption_reason: str | None = None


class Recording(WireModel):
    id: str
    client_session_id: str | None = Field(
        default=None,
        alias="clientSessionID",
    )
    created_at: str
    duration_seconds: float
    source: Literal["macos", "iphone", "browserDev"]
    status: Literal["completed", "interrupted"]
    transcript: str | None = None
    transcription_error: str | None = None
    observed_phones: list[str]
    phone_analysis_error: str | None = None
    phone_model_identifier: str | None = None
    phone_model_hash: str | None = None
    phone_runtime_identifier: str | None = None
    phone_analyzed_at: str | None = None
    word_phone_groups: list[WordPhoneGroup]
    unknown_reference_words: list[str]
    reference_pronunciation_error: str | None = None
    reference_dictionary_identifier: str | None = None
    reference_dictionary_hash: str | None = None
    sample_rate: int
    transport: RecordingTransportAudit | None = None


class RecordingListResponse(WireModel):
    recordings: list[Recording]


class ReferenceSpeechVoice(WireModel):
    identifier: str
    name: str
    language: Literal["en-US"] = "en-US"


class ReferenceSpeechSpeedState(WireModel):
    minimum: float
    default_value: float
    maximum: float


class ReferenceSpeechState(WireModel):
    schema_version: int
    status: Literal["unavailable", "preparing", "ready", "failed"]
    error: str | None = None
    language: Literal["en-US"] = "en-US"
    voices: list[ReferenceSpeechVoice]
    default_voice_identifier: str
    speed: ReferenceSpeechSpeedState
    model_identifier: str
    model_hash: str
    runtime_identifier: str
    license: str
    cache_bytes: int
    cache_maximum_bytes: int


class ReferenceSpeechScopeRequest(WireModel):
    kind: Literal["passage", "word"]
    index: int | None = None


class CreateReferenceSpeechArtifactRequest(WireModel):
    recording_id: str
    scope: ReferenceSpeechScopeRequest
    voice_identifier: str
    speed: float


class ReferenceSpeechArtifact(WireModel):
    id: str
    audio_hash: str
    text: str
    ipa: str
    duration_seconds: float
    sample_rate: int
    cache_hit: bool
    voice_identifier: str
    speed: float
    model_identifier: str
    model_hash: str
    voice_hash: str
    dictionary_identifier: str
    dictionary_hash: str
    synthesis_mapping_hash: str
    synthesized_at: str


# --- Signal analysis (mirror of voice.signals.to_json_payload) -------------


class VoiceSignalFramePayload(WireModel):
    elapsed_seconds: float
    rms: float
    peak: float
    decibels: float
    zero_crossing_rate: float
    spectral_centroid_hz: float
    spectral_rolloff_hz: float
    spectral_flatness: float
    low_band_ratio: float
    mid_band_ratio: float
    high_band_ratio: float


class VoiceSignalSummaryPayload(WireModel):
    duration_seconds: float
    sample_rate: int
    sample_count: int
    frame_count: int
    mean_rms: float
    max_rms: float
    peak_amplitude: float
    mean_decibels: float
    silence_ratio: float
    mean_zero_crossing_rate: float
    mean_spectral_centroid_hz: float


class SignalAnalysis(WireModel):
    summary: VoiceSignalSummaryPayload
    frames: list[VoiceSignalFramePayload]


# --- Pronunciation (mirror of voice.pronunciation.to_json_payload) ---------


class PronunciationFrameCostPayload(WireModel):
    reference_seconds: float
    learner_seconds: float
    cost: float


class PronunciationComparison(WireModel):
    distance: float
    closeness: float
    reference_frame_count: int
    learner_frame_count: int
    path_length: int
    coefficient_count: int
    trace: list[PronunciationFrameCostPayload]


# --- REST request models ---------------------------------------------------


class SaveRecordingRequest(WireModel):
    sample_rate: int
    pcm: str
    """Base64-encoded PCM of the full utterance in the ``encoding`` below."""
    transcript: str | None = None
    encoding: Literal["int16", "float32"] = "int16"


class AnalyzeSignalsRequest(WireModel):
    recording_id: str


class AnalyzePronunciationRequest(WireModel):
    reference_recording_id: str
    learner_recording_id: str


# --- Generation ------------------------------------------------------------


MODELS: Final[list[type[BaseModel]]] = [
    SessionStartMessage,
    AudioFrameMessage,
    SessionStopMessage,
    PartialTranscriptMessage,
    FinalTranscriptMessage,
    MeterMessage,
    SessionProgressMessage,
    SessionErrorMessage,
    SessionCompleteMessage,
    WordPhoneGroup,
    Recording,
    RecordingListResponse,
    ReferenceSpeechVoice,
    ReferenceSpeechSpeedState,
    ReferenceSpeechState,
    ReferenceSpeechScopeRequest,
    CreateReferenceSpeechArtifactRequest,
    ReferenceSpeechArtifact,
    VoiceSignalFramePayload,
    VoiceSignalSummaryPayload,
    SignalAnalysis,
    PronunciationFrameCostPayload,
    PronunciationComparison,
    SaveRecordingRequest,
    AnalyzeSignalsRequest,
    AnalyzePronunciationRequest,
]

_CLIENT_MESSAGES: Final = [
    "SessionStartMessage",
    "AudioFrameMessage",
    "SessionStopMessage",
]
_SERVER_MESSAGES: Final = [
    "PartialTranscriptMessage",
    "FinalTranscriptMessage",
    "MeterMessage",
    "SessionProgressMessage",
    "SessionErrorMessage",
    "SessionCompleteMessage",
]

_HEADER: Final = (
    "// AUTO-GENERATED by `just wire-gen`"
    " (src/interaction_agent/voice/wire.py). Do not edit by hand.\n\n"
)

_EMPTY_INTERFACE = re.compile(
    r"export interface [A-Za-z0-9_]+ \{\s*\}\n?",
)

_JSON2TS_PREAMBLE = re.compile(
    r"^/\* eslint-disable \*/\n/\*\*.*?\*/\n+",
    re.DOTALL,
)


def _strip_titles(node: Any) -> None:
    """Drop ``title`` recursively so json2ts inlines scalars, no alias soup."""
    if isinstance(node, dict):
        node.pop("title", None)
        for value in node.values():
            _strip_titles(value)
    elif isinstance(node, list):
        for value in node:
            _strip_titles(value)


def build_json_schema() -> dict[str, Any]:
    """JSON Schema with every wire model under ``$defs``.

    Pydantic gives every field an auto title; left in place, json2ts turns each
    into a standalone ``export type`` alias. We strip titles inside each model's
    properties so scalars inline directly into the interfaces, and neutralize
    the wrapper root into an empty (later stripped) interface with a stable
    name so the output is deterministic run to run.
    """
    _, schema = models_json_schema(
        [(model, "serialization") for model in MODELS],
        by_alias=True,
    )
    for definition in schema.get("$defs", {}).values():
        for prop in definition.get("properties", {}).values():
            _strip_titles(prop)
    schema["title"] = "WireContract"
    schema["type"] = "object"
    schema["properties"] = {}
    schema["additionalProperties"] = False
    return schema


def _union_alias(name: str, members: list[str]) -> str:
    body = "\n  | ".join(members)
    return f"export type {name} =\n  | {body};\n"


def render_typescript() -> str:
    """Run json2ts over the schema and append the message union aliases."""
    schema = build_json_schema()
    handle = tempfile.NamedTemporaryFile(
        "w",
        suffix=".json",
        delete=False,
        encoding="utf-8",
    )
    try:
        json.dump(schema, handle)
        handle.close()
        # Call the installed json2ts binary directly rather than via
        # `pnpm exec`: pnpm prints its own supply-chain-audit chatter to stdout,
        # which would otherwise be captured into the generated file.
        json2ts_bin = PROJECT_ROOT / "web" / "node_modules" / ".bin" / "json2ts"
        completed = subprocess.run(
            [
                str(json2ts_bin),
                "--unreachableDefinitions",
                "-i",
                handle.name,
            ],
            cwd=PROJECT_ROOT / "web",
            capture_output=True,
            text=True,
            check=True,
        )
    finally:
        Path(handle.name).unlink(missing_ok=True)

    without_preamble = _JSON2TS_PREAMBLE.sub("", completed.stdout, count=1)
    body = _EMPTY_INTERFACE.sub("", without_preamble).strip()
    unions = "\n".join(
        [
            _union_alias("ClientWireMessage", _CLIENT_MESSAGES),
            _union_alias("ServerWireMessage", _SERVER_MESSAGES),
        ]
    )
    return f"{_HEADER}{body}\n\n{unions}"


def main() -> int:
    WIRE_TS_PATH.parent.mkdir(parents=True, exist_ok=True)
    WIRE_TS_PATH.write_text(render_typescript(), encoding="utf-8")
    print(f"wrote {WIRE_TS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
