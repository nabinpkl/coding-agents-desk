import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Final, Literal
from uuid import uuid4

import numpy as np
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from interaction_agent.paths import VOICE_UPLOAD_ROOT
from interaction_agent.voice.config import load_voice_runtime_config
from interaction_agent.voice.live_mlx import (
    MlxLiveChunkTranscriber,
)
from interaction_agent.voice.phone_recognizer import (
    PhoneRecognition,
    ZIPAPhoneRecognizer,
)
from interaction_agent.voice.practice_passages import (
    PassageRevisionConflict,
    PracticePassageError,
    PracticePassageStore,
)
from interaction_agent.voice.pronunciation import compare_recordings, load_wav
from interaction_agent.voice.recording import (
    DEFAULT_SAMPLE_RATE,
    save_voice_recording,
    save_voice_recording_transcript,
    update_recording_metadata,
)
from interaction_agent.voice.reference_speech import (
    ReferenceSpeechArtifactStore,
    ReferenceSpeechError,
    ReferenceSpeechRevisionConflict,
    ReferenceSpeechScope,
    ReferenceSpeechSynthesisError,
)
from interaction_agent.voice.runtime import (
    BEST_MODEL,
    FAST_MODEL,
    SUPPORTED_MODELS,
    SUPPORTED_RESPONSE_FORMATS,
    SUPPORTED_TIMESTAMP_GRANULARITIES,
    VoiceRuntimeError,
    VoiceTranscriptionOptions,
    audio_suffix_for,
    duration_from_segments,
    format_srt,
    format_vtt,
    prewarm_transcription_model,
    transcribe_audio_path,
    transcript_text,
    validate_temperature,
    validate_transcription_result,
)
from interaction_agent.voice.signals import analyze_audio
from interaction_agent.voice.timing import emit_voice_timing
from interaction_agent.voice.web_stream import (
    FloatArray,
    VoiceWireError,
    compute_meter,
    decode_pcm,
    delete_recording,
    load_all_recordings,
    load_recording,
    load_recording_by_client_session_id,
    parse_client_message,
    recording_id_from_result,
    recording_json_path,
    recording_wav_path,
)
from interaction_agent.voice.wire import (
    AnalyzePronunciationRequest,
    AnalyzeSignalsRequest,
    AudioFrameMessage,
    CreatePracticePassageRequest,
    CreateReferenceSpeechArtifactRequest,
    FinalTranscriptMessage,
    MeterMessage,
    PartialTranscriptMessage,
    PracticePassage,
    PracticePassageAttemptsResponse,
    PracticePassageListResponse,
    PracticePassageReference,
    PronunciationComparison,
    Recording,
    RecordingListResponse,
    ReferenceSpeechArtifact,
    ReferenceSpeechState,
    SaveRecordingRequest,
    SessionCompleteMessage,
    SessionErrorMessage,
    SessionProgressMessage,
    SessionStartMessage,
    SignalAnalysis,
    UpdatePracticePassageBaselineRequest,
    UpdatePracticePassageTextRequest,
    WireModel,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Own model prewarm, the shared transcriber, and recording-session locks.

    Startup schedules silent Whisper and Kokoro inference before the user first
    needs either model. Each task uses the retained model owner and synthesis
    boundary also used by real work, so immediate uncached inference queues
    behind prewarm rather than racing it. Cached reference audio stays
    independently available. The HTTP server remains live while models prepare.
    ``voice_session_lock`` rejects a second recorder while a take is active.
    """
    app.state.voice_session_lock = asyncio.Lock()
    app.state.active_practice_passage_id = None
    app.state.active_voice_analyses = {}
    app.state.practice_passage_store = PracticePassageStore()
    await run_in_threadpool(
        app.state.practice_passage_store.migrate_legacy_recordings,
        recover_unattached_current=True,
    )
    app.state.voice_transcriber_lock = asyncio.Lock()
    app.state.voice_transcriber = None
    app.state.voice_phone_recognizer_lock = asyncio.Lock()
    app.state.voice_phone_inference_lock = asyncio.Lock()
    app.state.voice_phone_recognizer = None
    reference_speech_store = ReferenceSpeechArtifactStore()
    app.state.reference_speech_store = reference_speech_store
    whisper_prewarm_task = asyncio.create_task(prewarm_voice_model())
    kokoro_prewarm_task = asyncio.create_task(
        prewarm_reference_speech(reference_speech_store)
    )
    app.state.voice_model_prewarm_task = whisper_prewarm_task
    app.state.reference_speech_prewarm_task = kokoro_prewarm_task
    prewarm_tasks = (whisper_prewarm_task, kokoro_prewarm_task)
    try:
        yield
    finally:
        for prewarm_task in prewarm_tasks:
            if not prewarm_task.done():
                prewarm_task.cancel()
        for prewarm_task in prewarm_tasks:
            with suppress(asyncio.CancelledError):
                await prewarm_task
        transcriber = app.state.voice_transcriber
        if transcriber is not None:
            transcriber.finish_session()


async def prewarm_voice_model() -> None:
    """Prewarm the configured Whisper model without blocking server liveness."""
    try:
        config = load_voice_runtime_config()
        await run_in_threadpool(
            prewarm_transcription_model,
            config.final_transcription_model,
        )
    except Exception:
        logging.getLogger(__name__).exception(
            "voice model prewarm failed; the first transcription will retry"
        )


async def prewarm_reference_speech(store: ReferenceSpeechArtifactStore) -> None:
    """Prewarm the retained Kokoro synthesizer without blocking liveness."""
    started_at = time.perf_counter()
    cold_start: bool | None = None
    success = False
    error_type: str | None = None
    try:
        cold_start = await run_in_threadpool(store.prewarm)
        success = True
    except asyncio.CancelledError:
        error_type = "CancelledError"
        raise
    except Exception as exc:
        error_type = type(exc).__name__
        logging.getLogger(__name__).exception(
            "reference speech prewarm failed; the first synthesis will retry"
        )
    finally:
        emit_voice_timing(
            "kokoroPrewarm",
            coldStart=cold_start,
            success=success,
            errorType=error_type,
            totalMs=_elapsed_ms(started_at),
        )


app = FastAPI(
    title="Local OpenAI-compatible audio transcription",
    lifespan=lifespan,
)

DEFAULT_ALLOWED_ORIGINS: Final = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    # Embedded webview served from the native host's custom scheme. WKWebView
    # tags requests from an interactionfeed:// page with this origin (some
    # configs send "null" instead), so both are allowed. The sidecar is
    # loopback-only, so the phone still cannot reach it even with these listed.
    "interactionfeed://app",
    "null",
)


def load_allowed_origins() -> frozenset[str]:
    """Origins allowed to reach this server, for both REST and the WebSocket.

    WebSocket handshakes are not subject to the browser same-origin policy, so
    without this check any page the user visits could open ``/ws/voice`` and
    read back their transcripts or force recordings onto disk. Overridable via
    VOICE_ALLOWED_ORIGINS (comma-separated) since the dev port is
    environment-dependent (Next falls back to 3001 when 3000 is taken).
    """
    raw = os.environ.get("VOICE_ALLOWED_ORIGINS", "").strip()
    if raw:
        return frozenset(o.strip() for o in raw.split(",") if o.strip())
    return frozenset(DEFAULT_ALLOWED_ORIGINS)


ALLOWED_ORIGINS = load_allowed_origins()

# REST needs CORS because only one of the two clients is same-origin. In the
# browser the bundle reaches REST through a same-origin Next rewrite (see
# web/next.config.ts), but embedded in the native host's WKWebView the page is
# served from interactionfeed:// with no rewrite, so it fetches the sidecar's
# loopback origin directly and every call is cross-origin. Without this layer
# those fetches failed preflight (api.ts sends Content-Type on GETs too, so even
# the recordings list is preflighted) and the panel showed "Load failed".
# The same allowlist guards the WebSocket, which is exempt from CORS and does
# its own Origin check in voice_websocket().
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_ORIGINS),
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = VOICE_UPLOAD_ROOT
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.exception_handler(VoiceWireError)
async def voice_wire_error_handler(
    request: Any,
    exc: VoiceWireError,
) -> JSONResponse:
    del request
    return JSONResponse(status_code=400, content={"detail": str(exc)})


class TranscriptionResponse(BaseModel):
    text: str


class VerboseTranscriptionResponse(BaseModel):
    task: str
    language: str | None = None
    duration: float | None = None
    text: str
    segments: list[dict[str, Any]] | None = None


class HealthResponse(BaseModel):
    ok: bool
    transcription_endpoint: str
    supported_models: list[str]
    supported_response_formats: list[str]


class ModelResponse(BaseModel):
    id: str
    object: str
    created: int
    owned_by: str


class ModelsResponse(BaseModel):
    object: str
    data: list[ModelResponse]


def runtime_error_to_http(exc: VoiceRuntimeError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


@app.post("/v1/audio/transcriptions", response_model=None)
async def create_transcription(
    file: UploadFile = File(...),
    model: str = Form(...),
    language: str = Form("en"),
    prompt: str | None = Form(None),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
    stream: bool = Form(False),
    timestamp_granularities: Annotated[
        list[str] | None,
        Form(alias="timestamp_granularities[]"),
    ] = None,
    timestamp_granularities_plain: Annotated[
        list[str] | None,
        Form(alias="timestamp_granularities"),
    ] = None,
) -> TranscriptionResponse | VerboseTranscriptionResponse | PlainTextResponse:
    if response_format not in SUPPORTED_RESPONSE_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported response_format: {response_format}",
        )

    if stream:
        raise HTTPException(
            status_code=400,
            detail="Streaming transcriptions are not supported by this local backend",
        )

    try:
        validate_temperature(temperature)
        suffix = audio_suffix_for(file.filename)
    except VoiceRuntimeError as exc:
        raise runtime_error_to_http(exc) from exc

    requested_granularities = [
        *(timestamp_granularities or []),
        *(timestamp_granularities_plain or []),
    ]
    unsupported_granularities = sorted(
        set(requested_granularities) - SUPPORTED_TIMESTAMP_GRANULARITIES
    )
    if unsupported_granularities:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported timestamp granularity: {unsupported_granularities[0]}",
        )

    if requested_granularities and response_format != "verbose_json":
        raise HTTPException(
            status_code=400,
            detail="timestamp_granularities requires response_format=verbose_json",
        )

    audio_path = UPLOAD_DIR / f"{uuid4().hex}{suffix}"
    audio_path.write_bytes(await file.read())

    try:
        try:
            result = await run_in_threadpool(
                transcribe_audio_path,
                audio_path,
                VoiceTranscriptionOptions(
                    model=model,
                    purpose="rest",
                    language=language,
                    prompt=prompt,
                    temperature=temperature,
                    word_timestamps="word" in requested_granularities,
                ),
            )
        except VoiceRuntimeError as exc:
            raise runtime_error_to_http(exc) from exc

        text = transcript_text(result)
        segments = result.get("segments")

        if response_format == "text":
            return PlainTextResponse(text)

        if response_format == "srt":
            return PlainTextResponse(
                format_srt(segments),
                media_type="application/x-subrip",
            )

        if response_format == "vtt":
            return PlainTextResponse(format_vtt(segments), media_type="text/vtt")

        if response_format == "verbose_json":
            return VerboseTranscriptionResponse(
                task="transcribe",
                language=result.get("language"),
                duration=duration_from_segments(segments),
                text=text,
                segments=segments,
            )

        return TranscriptionResponse(text=text)
    finally:
        audio_path.unlink(missing_ok=True)


@app.get("/v1/models")
def list_models() -> ModelsResponse:
    return ModelsResponse(
        object="list",
        data=[
            ModelResponse(
                id=model,
                object="model",
                created=0,
                owned_by="local",
            )
            for model in sorted(SUPPORTED_MODELS)
        ],
    )


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(
        ok=True,
        transcription_endpoint="/v1/audio/transcriptions",
        supported_models=sorted(SUPPORTED_MODELS),
        supported_response_formats=sorted(SUPPORTED_RESPONSE_FORMATS),
    )


# --- Voice WebSocket -------------------------------------------------------


async def get_transcriber(app: FastAPI) -> MlxLiveChunkTranscriber:
    """Lazily build the shared live transcriber, guarded by a lock.

    Uses the MLX chunk transcriber (Apple-silicon Whisper), not the Sherpa
    streaming recognizer: its model ships/caches locally, so the live path needs
    no separate streaming-model fetch. It decodes a rolling window every
    interval, so the partial transcript is that window; the authoritative full
    transcript comes from the full-wav pass on session stop (finalize_session).
    """
    if app.state.voice_transcriber is not None:
        return app.state.voice_transcriber

    async with app.state.voice_transcriber_lock:
        if app.state.voice_transcriber is None:
            config = load_voice_runtime_config()
            app.state.voice_transcriber = await run_in_threadpool(
                lambda: MlxLiveChunkTranscriber(
                    model=config.final_transcription_model,
                    chunk_seconds=config.live_mlx_chunk_seconds,
                    interval_seconds=config.live_mlx_interval_seconds,
                    min_seconds=config.live_mlx_min_seconds,
                    preamp_gain=config.transcription_preamp,
                )
            )
    return app.state.voice_transcriber


async def send_wire(websocket: WebSocket, message: WireModel) -> None:
    await websocket.send_text(message.model_dump_json(by_alias=True))


def _elapsed_ms(started_at: float) -> float:
    return max(0.0, (time.perf_counter() - started_at) * 1000)


async def get_phone_recognizer(app: FastAPI) -> ZIPAPhoneRecognizer:
    if app.state.voice_phone_recognizer is not None:
        return app.state.voice_phone_recognizer
    async with app.state.voice_phone_recognizer_lock:
        if app.state.voice_phone_recognizer is None:
            started_at = time.perf_counter()
            success = False
            error_type: str | None = None
            try:
                app.state.voice_phone_recognizer = await run_in_threadpool(
                    ZIPAPhoneRecognizer
                )
                success = True
            except Exception as exc:
                error_type = type(exc).__name__
                raise
            finally:
                emit_voice_timing(
                    "zipaInitialization",
                    coldStart=True,
                    success=success,
                    errorType=error_type,
                    totalMs=_elapsed_ms(started_at),
                )
    return app.state.voice_phone_recognizer


async def analyze_recording_phones(
    app: FastAPI,
    recording_id: str,
) -> Recording:
    recognizer = await get_phone_recognizer(app)
    wav_path = recording_wav_path(recording_id)
    submitted_at = time.perf_counter()
    inference_ms = 0.0
    success = False
    error_type: str | None = None
    async with app.state.voice_phone_inference_lock:
        inference_started_at = time.perf_counter()
        try:
            result: PhoneRecognition = await run_in_threadpool(
                recognizer.analyze_wav,
                wav_path,
            )
            inference_ms = _elapsed_ms(inference_started_at)
            success = True
        except Exception as exc:
            inference_ms = _elapsed_ms(inference_started_at)
            error_type = type(exc).__name__
            raise
        finally:
            emit_voice_timing(
                "zipaInference",
                recordingID=recording_id,
                success=success,
                errorType=error_type,
                queueWaitMs=max(
                    0.0,
                    (inference_started_at - submitted_at) * 1000,
                ),
                inferenceMs=inference_ms,
                totalMs=_elapsed_ms(submitted_at),
            )
    await run_in_threadpool(
        update_recording_metadata,
        recording_json_path(recording_id),
        {
            "phoneAnalysis": {
                "status": "completed",
                "phones": list(result.phones),
                "error": None,
                "modelIdentifier": result.model_identifier,
                "modelHash": result.model_hash,
                "runtimeIdentifier": result.runtime_identifier,
                "analyzedAt": datetime.now().isoformat(),
            }
        },
    )
    return await run_in_threadpool(load_recording, recording_id)


async def send_progress(
    websocket: WebSocket | None,
    stage: Literal["saving", "transcribing", "analyzing"],
) -> None:
    if websocket is not None:
        await send_wire(websocket, SessionProgressMessage(stage=stage))


async def send_progress_best_effort(
    websocket: WebSocket | None,
    stage: Literal["saving", "transcribing", "analyzing"],
) -> bool:
    if websocket is None:
        return False
    try:
        await send_progress(websocket, stage)
        return True
    except Exception:
        logging.getLogger(__name__).warning(
            "voice client disconnected during %s progress delivery",
            stage,
            exc_info=True,
        )
        return False


async def finish_live_transcriber(transcriber: MlxLiveChunkTranscriber) -> float:
    """Wait for preview inference ownership to end before the final pass."""
    started_at = time.perf_counter()
    success = False
    error_type: str | None = None
    try:
        await run_in_threadpool(transcriber.finish_session)
        success = True
    except Exception as exc:
        error_type = type(exc).__name__
        logging.getLogger(__name__).exception(
            "live voice preview teardown failed; finalizing retained PCM"
        )
    duration_ms = _elapsed_ms(started_at)
    emit_voice_timing(
        "livePreviewDrain",
        success=success,
        errorType=error_type,
        totalMs=duration_ms,
    )
    return duration_ms


async def finalize_session(
    app: FastAPI,
    websocket: WebSocket | None,
    collected: list[FloatArray],
    sample_rate: int,
    started_at: datetime,
    source: Literal["macos", "iphone", "browserDev"],
    status: Literal["completed", "interrupted"],
    client_session_id: str | None = None,
    transport: dict[str, Any] | None = None,
    *,
    passage_id: str | None = None,
    post_stop_started_at: float | None = None,
    live_preview_drain_ms: float = 0.0,
) -> Recording | None:
    finalization_started_at = time.perf_counter()
    if post_stop_started_at is None:
        post_stop_started_at = finalization_started_at
    audio = (
        np.concatenate(collected)
        if collected
        else np.zeros(0, dtype=np.float32)
    )
    if audio.size == 0:
        if websocket is not None:
            await send_wire(
                websocket,
                SessionErrorMessage(
                    code="invalidSession",
                    message="No audio was received; the recording was discarded.",
                ),
            )
        emit_voice_timing(
            "voiceSession",
            recordingID=None,
            source=source,
            status=status,
            discarded=True,
            audioSeconds=0.0,
            livePreviewDrainMs=live_preview_drain_ms,
            postStopMs=_elapsed_ms(post_stop_started_at),
            success=False,
        )
        return None
    save_started_at = time.perf_counter()
    try:
        result = await run_in_threadpool(
            save_voice_recording,
            audio,
            sample_rate,
            started_at,
            source=source,
            status=status,
            client_session_id=client_session_id,
            transport=transport,
        )
    except Exception as exc:
        save_ms = _elapsed_ms(save_started_at)
        emit_voice_timing(
            "voiceSessionStage",
            phase="save",
            recordingID=None,
            success=False,
            errorType=type(exc).__name__,
            totalMs=save_ms,
        )
        emit_voice_timing(
            "voiceSession",
            recordingID=None,
            source=source,
            status=status,
            discarded=False,
            audioSeconds=audio.size / max(1, sample_rate),
            livePreviewDrainMs=live_preview_drain_ms,
            saveMs=save_ms,
            postStopMs=_elapsed_ms(post_stop_started_at),
            success=False,
        )
        raise
    save_ms = _elapsed_ms(save_started_at)
    recording_id = recording_id_from_result(result)
    emit_voice_timing(
        "voiceSessionStage",
        phase="save",
        recordingID=recording_id,
        success=True,
        errorType=None,
        totalMs=save_ms,
    )
    if not await send_progress_best_effort(websocket, "saving"):
        websocket = None

    # The live partial is only the last decoded window, so the authoritative
    # final transcript is a full-wav Whisper pass over the persisted recording.
    # A stage failure is persisted and does not remove the retained audio.
    if not await send_progress_best_effort(websocket, "transcribing"):
        websocket = None
    config = load_voice_runtime_config()
    final_text = ""
    transcription_started_at = time.perf_counter()
    transcription_success = False
    transcription_error_type: str | None = None
    try:
        final_result = await run_in_threadpool(
            transcribe_audio_path,
            result.wav_path,
            VoiceTranscriptionOptions(
                model=config.final_transcription_model,
                purpose="final",
                preamp_gain=config.transcription_preamp,
                condition_on_previous_text=False,
            ),
        )
        final_text = validate_transcription_result(
            final_result,
            audio_duration_seconds=result.analysis.summary.duration_seconds,
            require_usable_text=True,
        )
        await run_in_threadpool(
            save_voice_recording_transcript,
            result,
            final_text,
            f"mlx-whisper {config.final_transcription_model}",
        )
        transcription_success = True
    except Exception as exc:
        transcription_error_type = type(exc).__name__
        await run_in_threadpool(
            update_recording_metadata,
            result.json_path,
            {
                "transcription": {
                    "status": "failed",
                    "text": None,
                    "error": str(exc),
                    "engine": f"mlx-whisper {config.final_transcription_model}",
                }
            },
        )
    transcription_ms = _elapsed_ms(transcription_started_at)
    emit_voice_timing(
        "voiceSessionStage",
        phase="finalTranscription",
        recordingID=recording_id,
        success=transcription_success,
        errorType=transcription_error_type,
        totalMs=transcription_ms,
    )

    passage_store: PracticePassageStore | None = getattr(
        app.state,
        "practice_passage_store",
        None,
    )
    if passage_store is None:
        passage_store = PracticePassageStore()
    await run_in_threadpool(
        passage_store.attach_recording,
        recording_id,
        passage_id=passage_id,
        machine_transcript=final_text or None,
    )

    if not await send_progress_best_effort(websocket, "analyzing"):
        websocket = None
    phone_analysis_started_at = time.perf_counter()
    phone_analysis_success = False
    phone_analysis_error_type: str | None = None
    try:
        recording = await analyze_recording_phones(app, recording_id)
        phone_analysis_success = True
    except Exception as exc:
        phone_analysis_error_type = type(exc).__name__
        await run_in_threadpool(
            update_recording_metadata,
            result.json_path,
            {
                "phoneAnalysis": {
                    "status": "failed",
                    "phones": [],
                    "error": str(exc),
                    "modelIdentifier": None,
                    "modelHash": None,
                    "runtimeIdentifier": None,
                    "analyzedAt": datetime.now().isoformat(),
                }
            },
        )
        recording = await run_in_threadpool(load_recording, recording_id)
    phone_analysis_ms = _elapsed_ms(phone_analysis_started_at)
    emit_voice_timing(
        "voiceSessionStage",
        phase="phoneAnalysis",
        recordingID=recording_id,
        success=phone_analysis_success,
        errorType=phone_analysis_error_type,
        totalMs=phone_analysis_ms,
    )

    delivery_started_at = time.perf_counter()
    delivery_success = True
    delivery_error_type: str | None = None
    try:
        if websocket is not None:
            await send_wire(websocket, FinalTranscriptMessage(text=final_text))
            await send_wire(websocket, SessionCompleteMessage(recording=recording))
    except Exception as exc:
        delivery_success = False
        delivery_error_type = type(exc).__name__
        raise
    finally:
        delivery_ms = _elapsed_ms(delivery_started_at)
        emit_voice_timing(
            "voiceSessionStage",
            phase="delivery",
            recordingID=recording_id,
            success=delivery_success,
            errorType=delivery_error_type,
            totalMs=delivery_ms,
        )
        emit_voice_timing(
            "voiceSession",
            recordingID=recording_id,
            source=source,
            status=status,
            discarded=False,
            audioSeconds=audio.size / max(1, sample_rate),
            livePreviewDrainMs=live_preview_drain_ms,
            saveMs=save_ms,
            finalTranscriptionMs=transcription_ms,
            phoneAnalysisMs=phone_analysis_ms,
            deliveryMs=delivery_ms,
            finalizationMs=_elapsed_ms(finalization_started_at),
            postStopMs=_elapsed_ms(post_stop_started_at),
            success=(
                transcription_success
                and phone_analysis_success
                and delivery_success
            ),
        )
    return recording


async def run_voice_session(
    websocket: WebSocket,
    transcriber: MlxLiveChunkTranscriber,
    source: Literal["macos", "iphone", "browserDev"],
    client_session_id: str | None = None,
) -> None:
    collected: list[FloatArray] = []
    sample_rate = DEFAULT_SAMPLE_RATE
    started_at = datetime.now()
    session_open = False
    expected_sequence = 0
    received_sample_count = 0
    first_frame_received_at: str | None = None
    last_frame_received_at: str | None = None
    stop_received_at: str | None = None
    client_final_sequence: int | None = None
    client_captured_sample_count: int | None = None
    passage_id: str | None = None

    def transport_audit(
        continuity_status: Literal["complete", "interrupted"],
        interruption_reason: str | None = None,
    ) -> dict[str, Any]:
        return {
            "protocolIdentifier": "voice-audio-v2",
            "continuityStatus": continuity_status,
            "receivedFrameCount": expected_sequence,
            "receivedSampleCount": received_sample_count,
            "receivedFinalSequence": expected_sequence - 1,
            "clientFinalSequence": client_final_sequence,
            "clientCapturedSampleCount": client_captured_sample_count,
            "firstFrameReceivedAt": first_frame_received_at,
            "lastFrameReceivedAt": last_frame_received_at,
            "stopReceivedAt": stop_received_at,
            "interruptionReason": interruption_reason,
        }

    try:
        while True:
            raw = await websocket.receive_text()
            message = parse_client_message(raw)

            if isinstance(message, SessionStartMessage):
                if session_open:
                    raise VoiceWireError("sessionStart received while a session is active")
                if (message.passage_id is None) != (
                    message.passage_revision is None
                ):
                    raise VoiceWireError(
                        "sessionStart passage id and revision must appear together"
                    )
                if message.passage_id is not None:
                    passage = websocket.app.state.practice_passage_store.get_passage(
                        message.passage_id
                    )
                    if passage.revision != message.passage_revision:
                        raise VoiceWireError(
                            "practice passage changed before recording started"
                        )
                    passage_id = passage.id
                    websocket.app.state.active_practice_passage_id = passage.id
                else:
                    passage_id = None
                started_at = datetime.now()
                collected = []
                sample_rate = DEFAULT_SAMPLE_RATE
                expected_sequence = 0
                received_sample_count = 0
                first_frame_received_at = None
                last_frame_received_at = None
                stop_received_at = None
                client_final_sequence = None
                client_captured_sample_count = None
                if message.preamp_gain is not None:
                    transcriber.set_preamp_gain(message.preamp_gain)
                await run_in_threadpool(transcriber.start_session)
                session_open = True

            elif isinstance(message, AudioFrameMessage):
                if not session_open:
                    raise VoiceWireError("audioFrame received before sessionStart")
                if message.sequence != expected_sequence:
                    raise VoiceWireError(
                        "audioFrame sequence mismatch: "
                        f"expected {expected_sequence}, got {message.sequence}"
                    )
                samples = decode_pcm(message.pcm, message.encoding, message.channels)
                if expected_sequence > 0 and message.sample_rate != sample_rate:
                    raise VoiceWireError(
                        "audioFrame sample rate changed: "
                        f"expected {sample_rate}, got {message.sample_rate}"
                    )
                sample_rate = message.sample_rate
                collected.append(samples)
                received_at = datetime.now().isoformat()
                if first_frame_received_at is None:
                    first_frame_received_at = received_at
                last_frame_received_at = received_at
                expected_sequence += 1
                received_sample_count += int(samples.size)
                if samples.size != message.sample_count:
                    raise VoiceWireError(
                        "audioFrame sample count mismatch: "
                        f"declared {message.sample_count}, decoded {samples.size}"
                    )
                transcriber.submit_audio(samples, sample_rate)

                snapshot = transcriber.snapshot()
                await send_wire(
                    websocket,
                    PartialTranscriptMessage(text=snapshot.preview_text),
                )
                rms, peak = compute_meter(samples)
                await send_wire(websocket, MeterMessage(rms=rms, peak=peak))

            else:  # SessionStopMessage
                if not session_open:
                    raise VoiceWireError("sessionStop received before sessionStart")
                stop_received_at = datetime.now().isoformat()
                client_final_sequence = message.final_sequence
                client_captured_sample_count = message.captured_sample_count
                continuity_errors: list[str] = []
                if message.final_sequence != expected_sequence - 1:
                    continuity_errors.append(
                        "final sequence mismatch: "
                        f"client {message.final_sequence}, server {expected_sequence - 1}"
                    )
                if message.captured_sample_count != received_sample_count:
                    continuity_errors.append(
                        "sample count mismatch: "
                        f"client {message.captured_sample_count}, "
                        f"server {received_sample_count}"
                    )
                continuity_error = "; ".join(continuity_errors) or None
                status: Literal["completed", "interrupted"] = (
                    "interrupted" if continuity_error else "completed"
                )
                # Close the streaming session first, then persist and hand off.
                # session_open flips here so the except clauses below never
                # double-finish if persistence or the final pass raises.
                post_stop_started_at = time.perf_counter()
                live_preview_drain_ms = await finish_live_transcriber(transcriber)
                session_open = False
                await finalize_session(
                    websocket.app,
                    websocket,
                    collected,
                    sample_rate,
                    started_at,
                    source,
                    status,
                    client_session_id,
                    transport_audit(
                        "interrupted" if continuity_error else "complete",
                        continuity_error,
                    ),
                    passage_id=passage_id,
                    post_stop_started_at=post_stop_started_at,
                    live_preview_drain_ms=live_preview_drain_ms,
                )
                return
    except WebSocketDisconnect as exc:
        if session_open:
            post_stop_started_at = time.perf_counter()
            live_preview_drain_ms = await finish_live_transcriber(transcriber)
            session_open = False
            await finalize_session(
                websocket.app,
                None,
                collected,
                sample_rate,
                started_at,
                source,
                "interrupted",
                client_session_id,
                transport_audit("interrupted", f"websocket disconnected: {exc}"),
                passage_id=passage_id,
                post_stop_started_at=post_stop_started_at,
                live_preview_drain_ms=live_preview_drain_ms,
            )
    except VoiceWireError as exc:
        if session_open:
            post_stop_started_at = time.perf_counter()
            live_preview_drain_ms = await finish_live_transcriber(transcriber)
            session_open = False
            await finalize_session(
                websocket.app,
                None,
                collected,
                sample_rate,
                started_at,
                source,
                "interrupted",
                client_session_id,
                transport_audit("interrupted", str(exc)),
                passage_id=passage_id,
                post_stop_started_at=post_stop_started_at,
                live_preview_drain_ms=live_preview_drain_ms,
            )
        await websocket.close(code=1003, reason=str(exc)[:120])
    except Exception as exc:
        # Any other failure (e.g. the offline final pass, a persistence error)
        # must reach the client instead of hanging it: close loud with 1011 so
        # the browser transitions out of its finalization state.
        if session_open:
            post_stop_started_at = time.perf_counter()
            live_preview_drain_ms = await finish_live_transcriber(transcriber)
            session_open = False
            try:
                await finalize_session(
                    websocket.app,
                    None,
                    collected,
                    sample_rate,
                    started_at,
                    source,
                    "interrupted",
                    client_session_id,
                    transport_audit("interrupted", str(exc)),
                    passage_id=passage_id,
                    post_stop_started_at=post_stop_started_at,
                    live_preview_drain_ms=live_preview_drain_ms,
                )
            except Exception:
                logging.getLogger(__name__).exception(
                    "failed to finalize interrupted voice recording"
                )
        await websocket.close(code=1011, reason=str(exc)[:120])
    finally:
        if (
            passage_id is not None
            and getattr(
                websocket.app.state,
                "active_practice_passage_id",
                None,
            )
            == passage_id
        ):
            websocket.app.state.active_practice_passage_id = None


@app.websocket("/ws/voice")
async def voice_websocket(
    websocket: WebSocket,
    source: Literal["macos", "iphone", "browserDev"] = "browserDev",
    client_session_id: str | None = Query(
        default=None,
        alias="clientSessionID",
        max_length=128,
        pattern=r"^[A-Za-z0-9-]+$",
    ),
) -> None:
    origin = websocket.headers.get("origin")
    if origin is None or origin not in ALLOWED_ORIGINS:
        # Reject cross-site WebSocket connections before the handshake completes.
        await websocket.close(code=1008, reason="origin not allowed")
        return
    await websocket.accept()
    lock = websocket.app.state.voice_session_lock
    if lock.locked():
        await send_wire(
            websocket,
            SessionErrorMessage(
                code="recorderBusy",
                message="Another voice recording is already active.",
            ),
        )
        await websocket.close(code=1008, reason="recorder busy")
        return
    await lock.acquire()
    try:
        transcriber = await get_transcriber(websocket.app)
    except Exception as exc:  # model missing / load failure -> fail loud to client
        lock.release()
        await websocket.close(code=1011, reason=str(exc)[:120])
        return

    try:
        await run_voice_session(
            websocket,
            transcriber,
            source,
            client_session_id,
        )
    finally:
        lock.release()


# --- Recording REST --------------------------------------------------------


@app.get("/reference-speech/state", response_model=ReferenceSpeechState)
async def get_reference_speech_state() -> ReferenceSpeechState:
    return ReferenceSpeechState.model_validate(
        app.state.reference_speech_store.state()
    )


@app.post(
    "/reference-speech/artifacts",
    response_model=ReferenceSpeechArtifact,
)
async def create_reference_speech_artifact(
    request: CreateReferenceSpeechArtifactRequest,
) -> ReferenceSpeechArtifact:
    try:
        artifact = await run_in_threadpool(
            app.state.reference_speech_store.create,
            passage_id=request.passage_id,
            passage_revision=request.passage_revision,
            scope=ReferenceSpeechScope(
                kind=request.scope.kind,
                index=request.scope.index,
            ),
            voice_identifier=request.voice_identifier,
            speed=request.speed,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReferenceSpeechSynthesisError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ReferenceSpeechRevisionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ReferenceSpeechError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ReferenceSpeechArtifact.model_validate(asdict(artifact))


@app.get("/reference-speech/artifacts/{artifact_id}/audio")
async def get_reference_speech_audio(artifact_id: str) -> FileResponse:
    try:
        lease = await run_in_threadpool(
            app.state.reference_speech_store.lease_audio,
            artifact_id,
        )
    except ReferenceSpeechError as exc:
        status = 400 if "Invalid" in str(exc) else 404
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    try:
        return FileResponse(
            lease.path,
            media_type="audio/wav",
            filename=f"{artifact_id}.wav",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
            background=BackgroundTask(lease.release),
        )
    except Exception:
        lease.release()
        raise


@app.post("/recordings", response_model=Recording)
async def create_recording(request: SaveRecordingRequest) -> Recording:
    samples = decode_pcm(request.pcm, request.encoding)
    result = await run_in_threadpool(
        save_voice_recording,
        samples,
        request.sample_rate,
        datetime.now(),
    )
    if request.machine_transcript is not None:
        await run_in_threadpool(
            save_voice_recording_transcript,
            result,
            request.machine_transcript,
        )
    passage_store = PracticePassageStore()
    await run_in_threadpool(
        passage_store.attach_recording,
        recording_id_from_result(result),
        passage_id=None,
        machine_transcript=request.machine_transcript,
    )
    return await run_in_threadpool(
        load_recording,
        recording_id_from_result(result),
    )


def passage_http_exception(exc: Exception) -> HTTPException:
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, PassageRevisionConflict):
        return HTTPException(status_code=409, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@app.get(
    "/practice-passages",
    response_model=PracticePassageListResponse,
)
async def list_practice_passages(
    cursor: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=50, ge=1, le=100),
) -> PracticePassageListResponse:
    try:
        passages, next_cursor = await run_in_threadpool(
            app.state.practice_passage_store.list_passages,
            limit=limit,
            cursor=cursor,
        )
    except (PracticePassageError, FileNotFoundError) as exc:
        raise passage_http_exception(exc) from exc
    return PracticePassageListResponse(
        passages=passages,
        next_cursor=next_cursor,
    )


@app.post(
    "/practice-passages",
    response_model=PracticePassage,
    status_code=201,
)
async def create_practice_passage(
    request: CreatePracticePassageRequest,
) -> PracticePassage:
    try:
        return await run_in_threadpool(
            app.state.practice_passage_store.create_passage,
            request.intended_text,
        )
    except PracticePassageError as exc:
        raise passage_http_exception(exc) from exc


@app.get(
    "/practice-passages/{passage_id}",
    response_model=PracticePassage,
)
async def get_practice_passage(passage_id: str) -> PracticePassage:
    try:
        return await run_in_threadpool(
            app.state.practice_passage_store.get_passage,
            passage_id,
        )
    except (PracticePassageError, FileNotFoundError) as exc:
        raise passage_http_exception(exc) from exc


@app.get(
    "/practice-passages/{passage_id}/reference",
    response_model=PracticePassageReference,
)
async def get_practice_passage_reference(
    passage_id: str,
    revision: int = Query(ge=1),
) -> PracticePassageReference:
    try:
        return await run_in_threadpool(
            app.state.practice_passage_store.get_reference,
            passage_id,
            expected_revision=revision,
        )
    except (PracticePassageError, FileNotFoundError) as exc:
        raise passage_http_exception(exc) from exc


@app.get(
    "/practice-passages/{passage_id}/attempts",
    response_model=PracticePassageAttemptsResponse,
)
async def list_practice_passage_attempts(
    passage_id: str,
    cursor: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=50, ge=1, le=100),
) -> PracticePassageAttemptsResponse:
    try:
        passage, attempts, next_cursor = await run_in_threadpool(
            app.state.practice_passage_store.list_attempts,
            passage_id,
            limit=limit,
            cursor=cursor,
        )
    except (PracticePassageError, FileNotFoundError) as exc:
        raise passage_http_exception(exc) from exc
    return PracticePassageAttemptsResponse(
        passage=passage,
        attempts=attempts,
        next_cursor=next_cursor,
    )


@app.post(
    "/practice-passages/{passage_id}/intended-text",
    response_model=PracticePassage,
)
async def update_practice_passage_text(
    passage_id: str,
    request: UpdatePracticePassageTextRequest,
) -> PracticePassage:
    if app.state.active_practice_passage_id == passage_id:
        raise HTTPException(
            status_code=409,
            detail="Finish the active retake before editing intended text",
        )
    try:
        return await run_in_threadpool(
            app.state.practice_passage_store.update_intended_text,
            passage_id,
            expected_revision=request.expected_revision,
            intended_text=request.intended_text,
        )
    except (PracticePassageError, FileNotFoundError) as exc:
        raise passage_http_exception(exc) from exc


@app.post(
    "/practice-passages/{passage_id}/baseline",
    response_model=PracticePassage,
)
async def update_practice_passage_baseline(
    passage_id: str,
    request: UpdatePracticePassageBaselineRequest,
) -> PracticePassage:
    if app.state.active_practice_passage_id == passage_id:
        raise HTTPException(
            status_code=409,
            detail="Finish the active retake before changing its baseline",
        )
    try:
        return await run_in_threadpool(
            app.state.practice_passage_store.update_baseline,
            passage_id,
            expected_revision=request.expected_revision,
            recording_id=request.recording_id,
        )
    except (PracticePassageError, FileNotFoundError) as exc:
        raise passage_http_exception(exc) from exc


@app.delete(
    "/practice-passages/{passage_id}/attempts/{recording_id}",
    response_model=PracticePassage,
)
async def remove_practice_passage_attempt(
    passage_id: str,
    recording_id: str,
) -> PracticePassage:
    if app.state.active_practice_passage_id == passage_id:
        raise HTTPException(
            status_code=409,
            detail="Finish the active retake before deleting an attempt",
        )
    if recording_id in app.state.active_voice_analyses:
        raise HTTPException(
            status_code=409,
            detail="Finish reanalysis before deleting this attempt",
        )
    try:
        updated_passage = await run_in_threadpool(
            app.state.practice_passage_store.delete_attempt,
            passage_id,
            recording_id,
        )
    except (PracticePassageError, FileNotFoundError) as exc:
        raise passage_http_exception(exc) from exc
    if updated_passage is None:
        raise HTTPException(status_code=404, detail="recording not found")
    return updated_passage


@app.delete("/practice-passages/{passage_id}", status_code=204)
async def remove_practice_passage(passage_id: str) -> Response:
    if app.state.active_practice_passage_id == passage_id:
        raise HTTPException(
            status_code=409,
            detail="Finish the active retake before deleting this passage",
        )
    if passage_id in app.state.active_voice_analyses.values():
        raise HTTPException(
            status_code=409,
            detail="Finish reanalysis before deleting this passage",
        )
    try:
        await run_in_threadpool(
            app.state.practice_passage_store.delete_passage,
            passage_id,
        )
    except (PracticePassageError, FileNotFoundError) as exc:
        raise passage_http_exception(exc) from exc
    return Response(status_code=204)


@app.get("/recordings", response_model=RecordingListResponse)
async def list_recordings() -> RecordingListResponse:
    recordings = await run_in_threadpool(load_all_recordings)
    return RecordingListResponse(recordings=recordings)


@app.get(
    "/recordings/client-session/{client_session_id}",
    response_model=Recording,
)
async def get_recording_by_client_session(
    client_session_id: str,
) -> Recording:
    recording = await run_in_threadpool(
        load_recording_by_client_session_id,
        client_session_id,
    )
    if recording is None:
        raise HTTPException(
            status_code=404,
            detail="recording not found for client session",
        )
    return recording


@app.get("/recordings/{recording_id}", response_model=Recording)
async def get_recording(recording_id: str) -> Recording:
    json_path = recording_json_path(recording_id)
    if not json_path.exists():
        raise HTTPException(status_code=404, detail=f"recording not found: {recording_id}")
    return await run_in_threadpool(load_recording, recording_id)


@app.get("/recordings/{recording_id}/audio")
async def get_recording_audio(recording_id: str) -> FileResponse:
    """Serve the saved wav so a client can play the recording back.

    The rest of the recording API is metadata; this is the only route that hands
    back the audio itself. ``recording_wav_path`` validates the id against the
    session-id pattern, so a caller cannot walk out of the recordings directory.
    """
    wav_path = recording_wav_path(recording_id)
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail=f"recording not found: {recording_id}")
    return FileResponse(wav_path, media_type="audio/wav", filename=f"{recording_id}.wav")


@app.delete("/recordings/{recording_id}", status_code=204)
async def remove_recording(recording_id: str) -> Response:
    try:
        recording = await run_in_threadpool(load_recording, recording_id)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail=f"recording not found: {recording_id}",
        ) from exc
    if app.state.active_practice_passage_id == recording.passage_id:
        raise HTTPException(
            status_code=409,
            detail="Finish the active retake before deleting an attempt",
        )
    if recording_id in app.state.active_voice_analyses:
        raise HTTPException(
            status_code=409,
            detail="Finish reanalysis before deleting this attempt",
        )
    deleted = await run_in_threadpool(delete_recording, recording_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"recording not found: {recording_id}")
    return Response(status_code=204)


@app.post("/recordings/{recording_id}/reanalyze", response_model=Recording)
async def reanalyze_recording(recording_id: str) -> Recording:
    wav_path = recording_wav_path(recording_id)
    if not wav_path.exists():
        raise HTTPException(status_code=404, detail=f"recording not found: {recording_id}")
    recording = await run_in_threadpool(load_recording, recording_id)
    active_analyses: dict[str, str] = app.state.active_voice_analyses
    if recording_id in active_analyses:
        raise HTTPException(
            status_code=409,
            detail="This attempt is already being reanalyzed",
        )
    active_analyses[recording_id] = recording.passage_id
    try:
        try:
            return await analyze_recording_phones(app, recording_id)
        except Exception as exc:
            await run_in_threadpool(
                update_recording_metadata,
                recording_json_path(recording_id),
                {
                    "phoneAnalysis": {
                        "status": "failed",
                        "phones": [],
                        "error": str(exc),
                        "modelIdentifier": None,
                        "modelHash": None,
                        "runtimeIdentifier": None,
                        "analyzedAt": datetime.now().isoformat(),
                    }
                },
            )
            return await run_in_threadpool(load_recording, recording_id)
    finally:
        active_analyses.pop(recording_id, None)


# --- Analysis REST ---------------------------------------------------------


def signal_payload(wav_path: Path) -> dict[str, Any]:
    audio, sample_rate = load_wav(wav_path)
    return analyze_audio(audio, sample_rate).to_json_payload()


@app.post("/analyze/signals", response_model=SignalAnalysis)
async def analyze_signals(request: AnalyzeSignalsRequest) -> SignalAnalysis:
    wav_path = recording_wav_path(request.recording_id)
    if not wav_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"recording not found: {request.recording_id}",
        )
    payload = await run_in_threadpool(signal_payload, wav_path)
    return SignalAnalysis.model_validate(payload)


def pronunciation_payload(reference_wav: Path, learner_wav: Path) -> dict[str, Any]:
    return compare_recordings(reference_wav, learner_wav).to_json_payload()


@app.post("/analyze/pronunciation", response_model=PronunciationComparison)
async def analyze_pronunciation(
    request: AnalyzePronunciationRequest,
) -> PronunciationComparison:
    reference_wav = recording_wav_path(request.reference_recording_id)
    learner_wav = recording_wav_path(request.learner_recording_id)
    for recording_id, wav_path in (
        (request.reference_recording_id, reference_wav),
        (request.learner_recording_id, learner_wav),
    ):
        if not wav_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"recording not found: {recording_id}",
            )
    payload = await run_in_threadpool(
        pronunciation_payload,
        reference_wav,
        learner_wav,
    )
    return PronunciationComparison.model_validate(payload)


def main() -> None:
    """Run the voice HTTP/WebSocket server on loopback (the `voice-server` entry).

    This is the stable entry point the host-owned sidecar spawns. Host and port
    come from the environment because the native host picks a free loopback port
    at launch (VOICE_HOST / VOICE_PORT); the defaults keep `uv run voice-server`
    usable standalone. It binds 127.0.0.1 by default, so the server is never
    reachable off the machine — the paired phone reaches voice only through the
    host-mounted webview, never this port.
    """
    import uvicorn

    host = os.environ.get("VOICE_HOST", "127.0.0.1")
    port = int(os.environ.get("VOICE_PORT", "7692"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()


__all__ = [
    "BEST_MODEL",
    "FAST_MODEL",
    "app",
    "main",
]
