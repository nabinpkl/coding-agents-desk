import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Final
from uuid import uuid4

import numpy as np
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from interaction_agent.paths import VOICE_UPLOAD_ROOT
from interaction_agent.voice.config import load_voice_runtime_config
from interaction_agent.voice.live_mlx import (
    MlxLiveChunkTranscriber,
    MlxLiveTranscriptSnapshot,
)
from interaction_agent.voice.pronunciation import compare_recordings, load_wav
from interaction_agent.voice.recording import (
    DEFAULT_SAMPLE_RATE,
    save_voice_recording,
    save_voice_recording_transcript,
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
    transcript_text,
    transcribe_audio_path,
    validate_temperature,
)
from interaction_agent.voice.signals import analyze_audio
from interaction_agent.voice.web_stream import (
    FloatArray,
    VoiceWireError,
    compute_meter,
    decode_pcm,
    load_all_recordings,
    load_recording,
    parse_client_message,
    recording_id_from_result,
    recording_json_path,
    recording_wav_path,
)
from interaction_agent.voice.wire import (
    AnalyzePronunciationRequest,
    AnalyzeSignalsRequest,
    AudioFrameMessage,
    FinalTranscriptMessage,
    MeterMessage,
    PartialTranscriptMessage,
    PronunciationComparison,
    Recording,
    RecordingListResponse,
    SaveRecordingRequest,
    SessionCompleteMessage,
    SessionStartMessage,
    SignalAnalysis,
    WireModel,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Own the shared live transcriber and the session serialization lock.

    The MLX chunk transcriber is expensive to construct (it loads the Whisper
    model), so a single instance is built lazily on the first WebSocket
    connection and reused across sessions. ``voice_session_lock`` serializes
    sessions because the one transcriber runs a single decode worker at a time.
    """
    app.state.voice_session_lock = asyncio.Lock()
    app.state.voice_transcriber_lock = asyncio.Lock()
    app.state.voice_transcriber = None
    try:
        yield
    finally:
        transcriber = app.state.voice_transcriber
        if transcriber is not None:
            transcriber.finish_session()


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
            result = transcribe_audio_path(
                audio_path=audio_path,
                options=VoiceTranscriptionOptions(
                    model=model,
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


async def finalize_session(
    websocket: WebSocket,
    snapshot: MlxLiveTranscriptSnapshot,
    collected: list[FloatArray],
    sample_rate: int,
    started_at: datetime,
) -> None:
    del snapshot  # The live preview is a rolling window; the final is a full pass.
    audio = (
        np.concatenate(collected)
        if collected
        else np.zeros(0, dtype=np.float32)
    )
    result = await run_in_threadpool(
        save_voice_recording,
        audio,
        sample_rate,
        started_at,
    )
    # The live partial is only the last decoded window, so the authoritative
    # final transcript is a full-wav Whisper pass over the persisted recording.
    # It fails loud (the caller closes 1011) rather than falling back silently.
    config = load_voice_runtime_config()
    final_result = await run_in_threadpool(
        transcribe_audio_path,
        result.wav_path,
        VoiceTranscriptionOptions(model=config.final_transcription_model),
    )
    final_text = transcript_text(final_result)
    if final_text:
        await run_in_threadpool(save_voice_recording_transcript, result, final_text)

    # sessionComplete is emitted ONLY after the recording is fully persisted.
    await send_wire(websocket, FinalTranscriptMessage(text=final_text))
    await send_wire(
        websocket,
        SessionCompleteMessage(recording_id=recording_id_from_result(result)),
    )


async def run_voice_session(
    websocket: WebSocket,
    transcriber: MlxLiveChunkTranscriber,
) -> None:
    collected: list[FloatArray] = []
    sample_rate = DEFAULT_SAMPLE_RATE
    started_at = datetime.now()
    session_open = False
    try:
        while True:
            raw = await websocket.receive_text()
            message = parse_client_message(raw)

            if isinstance(message, SessionStartMessage):
                started_at = datetime.now()
                collected = []
                if message.preamp_gain is not None:
                    transcriber.set_preamp_gain(message.preamp_gain)
                await run_in_threadpool(transcriber.start_session)
                session_open = True

            elif isinstance(message, AudioFrameMessage):
                if not session_open:
                    raise VoiceWireError("audioFrame received before sessionStart")
                samples = decode_pcm(message.pcm, message.encoding, message.channels)
                sample_rate = message.sample_rate
                collected.append(samples)
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
                # Close the streaming session first, then persist and hand off.
                # session_open flips here so the except clauses below never
                # double-finish if persistence or the final pass raises.
                snapshot = await run_in_threadpool(transcriber.finish_session)
                session_open = False
                await finalize_session(
                    websocket,
                    snapshot,
                    collected,
                    sample_rate,
                    started_at,
                )
                return
    except WebSocketDisconnect:
        if session_open:
            await run_in_threadpool(transcriber.finish_session)
    except VoiceWireError as exc:
        if session_open:
            await run_in_threadpool(transcriber.finish_session)
        await websocket.close(code=1003, reason=str(exc)[:120])
    except Exception as exc:
        # Any other failure (e.g. the offline final pass, a persistence error)
        # must reach the client instead of hanging it: close loud with 1011 so
        # the browser transitions out of its decoding state.
        if session_open:
            await run_in_threadpool(transcriber.finish_session)
        await websocket.close(code=1011, reason=str(exc)[:120])


@app.websocket("/ws/voice")
async def voice_websocket(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    if origin is None or origin not in ALLOWED_ORIGINS:
        # Reject cross-site WebSocket connections before the handshake completes.
        await websocket.close(code=1008, reason="origin not allowed")
        return
    await websocket.accept()
    try:
        transcriber = await get_transcriber(websocket.app)
    except Exception as exc:  # model missing / load failure -> fail loud to client
        await websocket.close(code=1011, reason=str(exc)[:120])
        return

    async with websocket.app.state.voice_session_lock:
        await run_voice_session(websocket, transcriber)


# --- Recording REST --------------------------------------------------------


@app.post("/recordings", response_model=Recording)
async def create_recording(request: SaveRecordingRequest) -> Recording:
    samples = decode_pcm(request.pcm, request.encoding)
    result = await run_in_threadpool(
        save_voice_recording,
        samples,
        request.sample_rate,
        datetime.now(),
    )
    if request.transcript is not None:
        await run_in_threadpool(
            save_voice_recording_transcript,
            result,
            request.transcript,
        )
    return await run_in_threadpool(
        load_recording,
        recording_id_from_result(result),
    )


@app.get("/recordings", response_model=RecordingListResponse)
async def list_recordings() -> RecordingListResponse:
    recordings = await run_in_threadpool(load_all_recordings)
    return RecordingListResponse(recordings=recordings)


@app.get("/recordings/{recording_id}", response_model=Recording)
async def get_recording(recording_id: str) -> Recording:
    json_path = recording_json_path(recording_id)
    if not json_path.exists():
        raise HTTPException(status_code=404, detail=f"recording not found: {recording_id}")
    return await run_in_threadpool(load_recording, recording_id)


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
    "app",
    "main",
    "FAST_MODEL",
    "BEST_MODEL",
]
