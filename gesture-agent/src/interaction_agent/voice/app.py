import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final, cast

import cv2
import numpy as np

from interaction_agent.voice.config import load_voice_runtime_config
from interaction_agent.voice.devices import AudioDeviceChoice, query_device_choices
from interaction_agent.voice.live_sherpa import (
    LiveTranscriptionSnapshot,
    SherpaLiveTranscriber,
)
from interaction_agent.voice.live_mlx import (
    MlxLiveChunkTranscriber,
    MlxLiveTranscriptSnapshot,
)
from interaction_agent.voice.recording import (
    FloatArray,
    VoiceInputRecorder,
    VoiceMeterSnapshot,
    VoiceRecordingResult,
    save_voice_recording_transcript,
)
from interaction_agent.voice.replay import VoiceReplayMonitor, VoiceReplaySnapshot
from interaction_agent.voice.runtime import (
    VoiceTranscriptionOptions,
    transcribe_audio_path,
    transcript_text,
)


LOGGER = logging.getLogger("voice_agent.app")

WINDOW_NAME: Final = "Voice Control Debug Recorder"
WINDOW_WIDTH: Final = 1120
WINDOW_HEIGHT: Final = 760
PANEL_BG: Final = (18, 23, 28)
TEXT: Final = (235, 241, 245)
MUTED: Final = (160, 170, 178)
GRID: Final = (45, 54, 61)
GREEN: Final = (80, 245, 140)
YELLOW: Final = (70, 205, 250)
ORANGE: Final = (0, 150, 255)
RED: Final = (60, 80, 255)
REPLAY_VOLUME_STEP: Final = 0.05
TRANSCRIPTION_PREAMP_STEP: Final = 1.0
INPUT_DROPDOWN_RECT: Final = (560, 108, 250, 30)
OUTPUT_DROPDOWN_RECT: Final = (830, 108, 260, 30)
DROPDOWN_ROW_HEIGHT: Final = 28
DROPDOWN_MAX_ROWS: Final = 8


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    width: int
    height: int

    def contains(self, px: int, py: int) -> bool:
        return (
            self.x <= px <= self.x + self.width
            and self.y <= py <= self.y + self.height
        )


@dataclass
class DeviceSelectorUi:
    input_open: bool = False
    output_open: bool = False
    message: str = ""
    message_until: float = 0.0

    def set_message(self, message: str, duration_seconds: float = 2.0) -> None:
        self.message = message
        self.message_until = time.monotonic() + duration_seconds

    def visible_message(self) -> str:
        if time.monotonic() > self.message_until:
            return ""
        return self.message


def run_voice_app() -> int:
    config = load_voice_runtime_config()
    try:
        live_transcriber = SherpaLiveTranscriber(
            preamp_gain=config.transcription_preamp,
        )
    except Exception as exc:
        LOGGER.exception("failed to initialize live transcription")
        return render_error_until_quit(f"live transcription unavailable: {exc}")

    replay_monitor = VoiceReplayMonitor(
        volume=config.replay_volume,
        buffer_seconds=config.replay_buffer_seconds,
    )
    mlx_transcriber = MlxLiveChunkTranscriber(
        model=config.final_transcription_model,
        chunk_seconds=config.live_mlx_chunk_seconds,
        interval_seconds=config.live_mlx_interval_seconds,
        min_seconds=config.live_mlx_min_seconds,
        preamp_gain=config.transcription_preamp,
    )
    input_choices = query_device_choices("input")
    output_choices = query_device_choices("output")
    selector_ui = DeviceSelectorUi()
    last_completed_transcript = ""

    def submit_recording_audio(samples: FloatArray, sample_rate: int) -> None:
        live_transcriber.submit_audio(samples, sample_rate)
        mlx_transcriber.submit_audio(samples, sample_rate)
        replay_monitor.submit_audio(samples, sample_rate)

    recorder = VoiceInputRecorder(recording_audio_sink=submit_recording_audio)
    try:
        recorder.start_stream()
    except Exception as exc:
        live_transcriber.finish_session()
        mlx_transcriber.finish_session()
        replay_monitor.stop()
        LOGGER.exception("failed to open microphone")
        return render_error_until_quit(f"microphone unavailable: {exc}")

    startup_snapshot = recorder.snapshot()
    LOGGER.info(
        "voice recorder microphone opened device=%s index=%s latency=%s sample_rate=%s",
        startup_snapshot.input_device_name,
        startup_snapshot.input_device_index,
        startup_snapshot.input_latency_seconds,
        startup_snapshot.sample_rate,
    )

    cv2.namedWindow(WINDOW_NAME)
    cv2.setMouseCallback(
        WINDOW_NAME,
        handle_mouse_click,
        (
            selector_ui,
            recorder,
            replay_monitor,
            input_choices,
            output_choices,
        ),
    )
    try:
        while True:
            frame = np.zeros((WINDOW_HEIGHT, WINDOW_WIDTH, 3), dtype=np.uint8)
            frame[:] = PANEL_BG

            snapshot = recorder.snapshot()
            transcript_snapshot = live_transcriber.snapshot()
            mlx_snapshot = mlx_transcriber.snapshot()
            replay_snapshot = replay_monitor.snapshot()
            draw_voice_debug_ui(
                frame,
                snapshot,
                recorder.last_result,
                transcript_snapshot,
                mlx_snapshot,
                replay_snapshot,
                last_completed_transcript,
                selector_ui,
                input_choices,
                output_choices,
            )
            cv2.imshow(WINDOW_NAME, frame)

            key = cv2.waitKey(16) & 0xFF
            if key == ord("r"):
                if snapshot.is_recording:
                    result = recorder.stop_recording()
                    transcript_result = live_transcriber.finish_session()
                    mlx_transcriber.finish_session()
                    replay_monitor.stop()
                    if result is not None:
                        final_transcript = transcribe_recording_offline(
                            result,
                            config.final_transcription_model,
                        )
                        transcript_source = (
                            f"mlx-whisper:{config.final_transcription_model}"
                        )
                        if not final_transcript:
                            final_transcript = transcript_result.full_text
                            transcript_source = "sherpa-onnx-streaming"

                        last_completed_transcript = final_transcript
                        if final_transcript:
                            save_voice_recording_transcript(
                                result,
                                final_transcript,
                                engine=transcript_source,
                            )
                            selector_ui.set_message("final transcript saved")
                        else:
                            selector_ui.set_message("no final transcript detected")
                        LOGGER.info(
                            "voice recording saved wav=%s json=%s frames=%s transcript_chars=%s",
                            result.wav_path,
                            result.json_path,
                            result.analysis.summary.frame_count,
                            len(final_transcript),
                        )
                elif snapshot.is_monitoring:
                    selector_ui.set_message("stop monitor before recording")
                else:
                    last_completed_transcript = ""
                    live_transcriber.start_session()
                    mlx_transcriber.start_session()
                    replay_monitor.start()
                    recorder.start_recording()
                    LOGGER.info("voice recording, transcription, and replay started")
            elif key == ord("m"):
                if snapshot.is_recording:
                    selector_ui.set_message("stop recording before monitoring")
                elif snapshot.is_monitoring:
                    recorder.stop_monitoring()
                    live_transcriber.finish_session()
                    mlx_transcriber.finish_session()
                    replay_monitor.stop()
                    selector_ui.set_message("monitor stopped")
                    LOGGER.info("voice monitor stopped")
                else:
                    last_completed_transcript = ""
                    live_transcriber.start_session()
                    mlx_transcriber.start_session()
                    replay_monitor.start()
                    recorder.start_monitoring()
                    selector_ui.set_message("monitor started")
                    LOGGER.info("voice monitor, transcription, and replay started")
            elif key == ord("q"):
                LOGGER.info("voice recorder quit requested")
                return 0
            elif key in (ord("="), ord("+")):
                replay_monitor.adjust_volume(REPLAY_VOLUME_STEP)
            elif key in (ord("-"), ord("_")):
                replay_monitor.adjust_volume(-REPLAY_VOLUME_STEP)
            elif key == ord("0"):
                replay_monitor.set_volume(0.0)
            elif key == ord("]"):
                live_transcriber.adjust_preamp_gain(TRANSCRIPTION_PREAMP_STEP)
                mlx_transcriber.adjust_preamp_gain(TRANSCRIPTION_PREAMP_STEP)
            elif key == ord("["):
                live_transcriber.adjust_preamp_gain(-TRANSCRIPTION_PREAMP_STEP)
                mlx_transcriber.adjust_preamp_gain(-TRANSCRIPTION_PREAMP_STEP)
    finally:
        cv2.setMouseCallback(WINDOW_NAME, lambda *args: None)
        live_transcriber.finish_session()
        mlx_transcriber.finish_session()
        replay_monitor.stop()
        recorder.stop_stream()
        cv2.destroyAllWindows()


def render_error_until_quit(message: str) -> int:
    cv2.namedWindow(WINDOW_NAME)
    try:
        while True:
            frame = np.zeros((WINDOW_HEIGHT, WINDOW_WIDTH, 3), dtype=np.uint8)
            frame[:] = PANEL_BG
            draw_text(frame, "VOICE RECORDER", 32, 52, 1.0, TEXT, 2)
            draw_text(frame, message, 32, 104, 0.72, RED, 2)
            draw_text(frame, "key=q quit", 32, 152, 0.68, MUTED, 2)
            cv2.imshow(WINDOW_NAME, frame)
            key = cv2.waitKey(16) & 0xFF
            if key == ord("q"):
                return 3
    finally:
        cv2.destroyAllWindows()


def transcribe_recording_offline(
    result: VoiceRecordingResult,
    model: str,
) -> str:
    try:
        whisper_result = transcribe_audio_path(
            result.wav_path,
            VoiceTranscriptionOptions(model=model),
        )
    except Exception:
        LOGGER.exception("offline transcription failed")
        return ""

    return transcript_text(whisper_result)


def draw_voice_debug_ui(
    frame: np.ndarray,
    snapshot: VoiceMeterSnapshot,
    last_result: VoiceRecordingResult | None,
    transcript: LiveTranscriptionSnapshot,
    mlx_transcript: MlxLiveTranscriptSnapshot,
    replay: VoiceReplaySnapshot,
    final_transcript_text: str,
    selector_ui: DeviceSelectorUi,
    input_choices: tuple[AudioDeviceChoice, ...],
    output_choices: tuple[AudioDeviceChoice, ...],
) -> None:
    draw_header(frame, snapshot, selector_ui)
    draw_meter_panel(frame, snapshot)
    draw_waveform_panel(frame, snapshot)
    draw_history_panel(frame, snapshot)
    draw_raw_data_panel(
        frame,
        snapshot,
        last_result,
        transcript,
        mlx_transcript,
        replay,
        final_transcript_text,
    )
    draw_device_selectors(
        frame,
        snapshot,
        replay,
        selector_ui,
        input_choices,
        output_choices,
    )


def draw_header(
    frame: np.ndarray,
    snapshot: VoiceMeterSnapshot,
    selector_ui: DeviceSelectorUi,
) -> None:
    if snapshot.is_recording:
        status = "REC ON"
        status_color = RED
    elif snapshot.is_monitoring:
        status = "MON ON"
        status_color = YELLOW
    else:
        status = "REC OFF"
        status_color = GREEN
    draw_text(frame, "VOICE DEBUG RECORDER", 30, 48, 0.95, TEXT, 2)
    draw_text(frame, status, 30, 86, 0.78, status_color, 2)
    draw_text(
        frame,
        "r record   m monitor   [/ ] asr gain   -/+ replay   0 mute   q quit",
        190,
        86,
        0.52,
        MUTED,
        2,
    )
    draw_text(
        frame,
        f"rate={snapshot.sample_rate}Hz active={snapshot.recording_seconds:.2f}s "
        f"drops={snapshot.dropped_blocks}",
        30,
        124,
        0.58,
        MUTED,
        1,
    )
    latency = (
        "unknown"
        if snapshot.input_latency_seconds is None
        else f"{snapshot.input_latency_seconds:.4f}s"
    )
    draw_text(
        frame,
        f"input_latency={latency}",
        30,
        146,
        0.50,
        MUTED,
        1,
    )
    message = selector_ui.visible_message()
    if message:
        draw_text(frame, message, 190, 146, 0.50, YELLOW, 1)


def draw_meter_panel(frame: np.ndarray, snapshot: VoiceMeterSnapshot) -> None:
    draw_panel(frame, 30, 154, 500, 232, "LIVE METERS")
    draw_horizontal_meter(frame, "rms", snapshot.rms, 60, 215, 430, GREEN, scale=0.30)
    draw_horizontal_meter(frame, "peak", snapshot.peak, 60, 268, 430, YELLOW, scale=0.80)
    draw_horizontal_meter(
        frame,
        "zcr",
        snapshot.zero_crossing_rate,
        60,
        321,
        430,
        ORANGE,
        scale=0.35,
    )
    db_normalized = max(0.0, min(1.0, (snapshot.decibels + 80.0) / 80.0))
    active = snapshot.is_recording or snapshot.is_monitoring
    draw_horizontal_meter(
        frame,
        "dB",
        db_normalized,
        60,
        374,
        430,
        RED if snapshot.is_recording else YELLOW if active else GREEN,
        scale=1.0,
        value_text=f"{snapshot.decibels:.1f}",
    )


def draw_waveform_panel(frame: np.ndarray, snapshot: VoiceMeterSnapshot) -> None:
    x = 560
    y = 154
    width = 530
    height = 232
    draw_panel(frame, x, y, width, height, "RAW WAVEFORM LAST 2S")
    samples = np.array(snapshot.recent_audio, dtype=np.float32)
    plot_x = x + 20
    plot_y = y + 52
    plot_w = width - 40
    plot_h = height - 72
    draw_grid(frame, plot_x, plot_y, plot_w, plot_h)

    if samples.size < 2:
        return

    max_points = plot_w
    if samples.size > max_points:
        indices = np.linspace(0, samples.size - 1, max_points).astype(np.int32)
        samples = samples[indices]

    center_y = plot_y + plot_h // 2
    points: list[tuple[int, int]] = []
    for index, sample in enumerate(samples):
        px = plot_x + int(index / max(1, samples.size - 1) * (plot_w - 1))
        py = center_y - int(float(sample) * (plot_h * 0.45))
        points.append((px, py))

    for start, end in zip(points, points[1:]):
        cv2.line(frame, start, end, YELLOW, 1)

    cv2.line(frame, (plot_x, center_y), (plot_x + plot_w, center_y), GRID, 1)


def draw_history_panel(frame: np.ndarray, snapshot: VoiceMeterSnapshot) -> None:
    x = 30
    y = 414
    width = 500
    height = 292
    draw_panel(frame, x, y, width, height, "RMS BAR HISTORY")

    values = list(snapshot.recent_rms)
    bar_count = 64
    if len(values) > bar_count:
        values = values[-bar_count:]

    plot_x = x + 24
    plot_y = y + 58
    plot_w = width - 48
    plot_h = height - 86
    draw_grid(frame, plot_x, plot_y, plot_w, plot_h)
    if not values:
        return

    bar_w = max(2, plot_w // bar_count)
    for index, value in enumerate(values):
        normalized = max(0.0, min(1.0, value / 0.25))
        bar_h = int(normalized * plot_h)
        px = plot_x + index * bar_w
        py = plot_y + plot_h - bar_h
        color = RED if snapshot.is_recording else YELLOW if snapshot.is_monitoring else GREEN
        cv2.rectangle(frame, (px, py), (px + bar_w - 1, plot_y + plot_h), color, -1)


def draw_raw_data_panel(
    frame: np.ndarray,
    snapshot: VoiceMeterSnapshot,
    last_result: VoiceRecordingResult | None,
    transcript: LiveTranscriptionSnapshot,
    mlx_transcript: MlxLiveTranscriptSnapshot,
    replay: VoiceReplaySnapshot,
    final_transcript_text: str,
) -> None:
    x = 560
    y = 414
    width = 530
    height = 292
    draw_panel(frame, x, y, width, height, "LIVE TRANSCRIPT / REPLAY")
    transcript_status = live_status(transcript.is_active, False, transcript.last_error)
    mlx_status = live_status(
        mlx_transcript.is_active,
        mlx_transcript.is_decoding,
        mlx_transcript.last_error,
    )
    replay_status = "ERROR" if replay.last_error else "ON" if replay.is_active else "IDLE"

    status_y = y + 58
    draw_text(frame, "sherpa", x + 24, status_y, 0.48, MUTED, 1)
    draw_text(frame, transcript_status, x + 96, status_y, 0.48, TEXT, 1)
    draw_text(frame, "mlx", x + 190, status_y, 0.48, MUTED, 1)
    draw_text(frame, mlx_status, x + 236, status_y, 0.48, TEXT, 1)
    draw_text(frame, "replay", x + 330, status_y, 0.48, MUTED, 1)
    draw_text(frame, replay_status, x + 396, status_y, 0.48, TEXT, 1)

    detail_y = status_y + 24
    detail_text = (
        f"asr {transcript.preamp_gain:.1f}x   replay {replay.volume * 100:.0f}%   "
        f"active {snapshot.recording_seconds:.2f}s"
    )
    draw_text(frame, detail_text, x + 24, detail_y, 0.46, MUTED, 1)

    if transcript.dropped_blocks or mlx_transcript.dropped_blocks or replay.dropped_samples:
        drop_text = (
            f"drops sherpa={transcript.dropped_blocks} "
            f"mlx={mlx_transcript.dropped_blocks} replay={replay.dropped_samples}"
        )
        draw_text(frame, drop_text, x + 24, detail_y + 22, 0.42, ORANGE, 1)

    saved_text = "saved none yet"
    if last_result is not None:
        summary = last_result.analysis.summary
        saved_text = f"saved {summary.frame_count} frames  {shorten_path(last_result.wav_path)}"
    draw_text(frame, trim_to_width(saved_text, width - 48, 0.42, 1), x + 24, y + 126, 0.42, MUTED, 1)

    transcript_y = y + 150
    transcript_height = y + height - transcript_y - 18
    gap = 14
    column_width = (width - 48 - gap) // 2
    sherpa_text = transcript.last_error or transcript.full_text
    mlx_text = mlx_transcript.last_error or mlx_transcript.preview_text
    if not sherpa_text:
        sherpa_text = "waiting for speech" if transcript.is_active else "idle"
    if not mlx_text:
        mlx_text = final_transcript_text or ("warming up" if mlx_transcript.is_active else "idle")

    draw_transcript_column(
        frame,
        "sherpa live",
        sherpa_text,
        x + 24,
        transcript_y,
        column_width,
        transcript_height,
        RED if transcript.last_error else TEXT,
    )
    draw_transcript_column(
        frame,
        "mlx chunks",
        mlx_text,
        x + 24 + column_width + gap,
        transcript_y,
        column_width,
        transcript_height,
        RED if mlx_transcript.last_error else YELLOW,
    )


def live_status(is_active: bool, is_decoding: bool, error: str | None) -> str:
    if error:
        return "ERROR"
    if is_decoding:
        return "BUSY"
    if is_active:
        return "ON"
    return "IDLE"


def draw_transcript_column(
    frame: np.ndarray,
    title: str,
    text: str,
    x: int,
    y: int,
    width: int,
    height: int,
    color: tuple[int, int, int],
) -> None:
    cv2.rectangle(frame, (x, y), (x + width, y + height), (12, 17, 22), -1)
    cv2.rectangle(frame, (x, y), (x + width, y + height), GRID, 1)
    draw_text(frame, title, x + 10, y + 21, 0.44, MUTED, 1)
    max_lines = max(1, (height - 40) // 21)
    lines = wrap_text(text, width - 20, 0.48, 1, max_lines)
    for index, line in enumerate(lines):
        draw_text(frame, line, x + 10, y + 48 + index * 21, 0.48, color, 1)


def draw_device_selectors(
    frame: np.ndarray,
    snapshot: VoiceMeterSnapshot,
    replay: VoiceReplaySnapshot,
    selector_ui: DeviceSelectorUi,
    input_choices: tuple[AudioDeviceChoice, ...],
    output_choices: tuple[AudioDeviceChoice, ...],
) -> None:
    input_label = active_device_label(
        snapshot.input_device_name,
        snapshot.input_device_index,
        "input",
    )
    output_label = active_device_label(
        replay.output_device_name,
        replay.output_device_index,
        "output",
    )
    draw_dropdown(
        frame,
        "INPUT",
        input_label,
        Rect(*INPUT_DROPDOWN_RECT),
        selector_ui.input_open,
        input_choices,
        snapshot.input_device_index,
    )
    draw_dropdown(
        frame,
        "OUTPUT",
        output_label,
        Rect(*OUTPUT_DROPDOWN_RECT),
        selector_ui.output_open,
        output_choices,
        replay.output_device_index,
    )


def draw_dropdown(
    frame: np.ndarray,
    label: str,
    value: str,
    rect: Rect,
    is_open: bool,
    choices: tuple[AudioDeviceChoice, ...],
    selected_index: int | None,
) -> None:
    draw_text(frame, label, rect.x, rect.y - 8, 0.42, MUTED, 1)
    cv2.rectangle(
        frame,
        (rect.x, rect.y),
        (rect.x + rect.width, rect.y + rect.height),
        (9, 13, 17),
        -1,
    )
    cv2.rectangle(
        frame,
        (rect.x, rect.y),
        (rect.x + rect.width, rect.y + rect.height),
        YELLOW if is_open else GRID,
        1,
    )
    text = trim_to_width(value, rect.width - 38, 0.46, 1)
    draw_text(frame, text, rect.x + 10, rect.y + 20, 0.46, TEXT, 1)
    arrow_x = rect.x + rect.width - 20
    arrow_y = rect.y + rect.height // 2
    points = np.array(
        [
            [arrow_x - 5, arrow_y - 3],
            [arrow_x + 5, arrow_y - 3],
            [arrow_x, arrow_y + 5],
        ],
        dtype=np.int32,
    )
    cv2.fillConvexPoly(frame, points, MUTED)

    if not is_open:
        return

    visible_choices = choices[:DROPDOWN_MAX_ROWS]
    menu_height = len(visible_choices) * DROPDOWN_ROW_HEIGHT
    menu_y = rect.y + rect.height + 2
    cv2.rectangle(
        frame,
        (rect.x, menu_y),
        (rect.x + rect.width, menu_y + menu_height),
        (13, 18, 23),
        -1,
    )
    cv2.rectangle(
        frame,
        (rect.x, menu_y),
        (rect.x + rect.width, menu_y + menu_height),
        YELLOW,
        1,
    )
    for index, choice in enumerate(visible_choices):
        row_y = menu_y + index * DROPDOWN_ROW_HEIGHT
        is_selected = choice.index == selected_index
        if is_selected:
            cv2.rectangle(
                frame,
                (rect.x + 1, row_y + 1),
                (rect.x + rect.width - 1, row_y + DROPDOWN_ROW_HEIGHT - 1),
                (34, 48, 56),
                -1,
            )
        row_label = format_device_choice(choice)
        text = trim_to_width(row_label, rect.width - 20, 0.43, 1)
        color = TEXT if is_selected else MUTED
        draw_text(frame, text, rect.x + 10, row_y + 19, 0.43, color, 1)


def active_device_label(name: str, index: int | None, kind: str) -> str:
    if index is None:
        return f"Default: {name}"
    return f"{index}: {name or kind}"


def format_device_choice(choice: AudioDeviceChoice) -> str:
    prefix = "Default" if choice.index is None else str(choice.index)
    channels = []
    if choice.input_channels:
        channels.append(f"in {choice.input_channels}")
    if choice.output_channels:
        channels.append(f"out {choice.output_channels}")
    channel_text = f" ({', '.join(channels)})" if channels else ""
    marker = " *" if choice.is_default and choice.index is not None else ""
    return f"{prefix}: {choice.name}{channel_text}{marker}"


def handle_mouse_click(
    event: int,
    x: int,
    y: int,
    flags: int,
    param: object,
) -> None:
    del flags
    if event != cv2.EVENT_LBUTTONDOWN:
        return

    payload = cast(
        tuple[
            DeviceSelectorUi,
            VoiceInputRecorder,
            VoiceReplayMonitor,
            tuple[AudioDeviceChoice, ...],
            tuple[AudioDeviceChoice, ...],
        ],
        param,
    )
    (
        selector_ui,
        recorder,
        replay_monitor,
        input_choices,
        output_choices,
    ) = payload
    if not isinstance(selector_ui, DeviceSelectorUi):
        return

    input_rect = Rect(*INPUT_DROPDOWN_RECT)
    output_rect = Rect(*OUTPUT_DROPDOWN_RECT)

    if input_rect.contains(x, y):
        selector_ui.input_open = not selector_ui.input_open
        selector_ui.output_open = False
        return
    if output_rect.contains(x, y):
        selector_ui.output_open = not selector_ui.output_open
        selector_ui.input_open = False
        return

    if selector_ui.input_open:
        choice = dropdown_choice_at(input_rect, input_choices, x, y)
        if choice is not None and isinstance(recorder, VoiceInputRecorder):
            select_input_device(selector_ui, recorder, choice)
            selector_ui.input_open = False
            return

    if selector_ui.output_open:
        choice = dropdown_choice_at(output_rect, output_choices, x, y)
        if choice is not None and isinstance(replay_monitor, VoiceReplayMonitor):
            select_output_device(selector_ui, replay_monitor, choice)
            selector_ui.output_open = False
            return

    selector_ui.input_open = False
    selector_ui.output_open = False


def dropdown_choice_at(
    rect: Rect,
    choices: tuple[AudioDeviceChoice, ...],
    x: int,
    y: int,
) -> AudioDeviceChoice | None:
    if x < rect.x or x > rect.x + rect.width:
        return None

    menu_y = rect.y + rect.height + 2
    if y < menu_y:
        return None
    index = (y - menu_y) // DROPDOWN_ROW_HEIGHT
    visible_choices = choices[:DROPDOWN_MAX_ROWS]
    if 0 <= index < len(visible_choices):
        return visible_choices[index]
    return None


def select_input_device(
    selector_ui: DeviceSelectorUi,
    recorder: VoiceInputRecorder,
    choice: AudioDeviceChoice,
) -> None:
    try:
        recorder.set_input_device(choice.index)
    except Exception as exc:
        selector_ui.set_message(str(exc))
        return
    selector_ui.set_message(f"input: {choice.name}")


def select_output_device(
    selector_ui: DeviceSelectorUi,
    replay_monitor: VoiceReplayMonitor,
    choice: AudioDeviceChoice,
) -> None:
    try:
        replay_monitor.set_output_device(choice.index)
    except Exception as exc:
        selector_ui.set_message(str(exc))
        return
    selector_ui.set_message(f"output: {choice.name}")


def draw_panel(
    frame: np.ndarray,
    x: int,
    y: int,
    width: int,
    height: int,
    title: str,
) -> None:
    cv2.rectangle(frame, (x, y), (x + width, y + height), (27, 34, 40), -1)
    cv2.rectangle(frame, (x, y), (x + width, y + height), (65, 76, 84), 1)
    draw_text(frame, title, x + 18, y + 32, 0.58, TEXT, 1)


def draw_horizontal_meter(
    frame: np.ndarray,
    label: str,
    value: float,
    x: int,
    y: int,
    width: int,
    color: tuple[int, int, int],
    scale: float,
    value_text: str | None = None,
) -> None:
    label_w = 72
    bar_x = x + label_w
    normalized = max(0.0, min(1.0, value / max(scale, 1e-8)))
    cv2.rectangle(frame, (bar_x, y - 18), (bar_x + width, y + 10), (10, 14, 18), -1)
    cv2.rectangle(frame, (bar_x, y - 18), (bar_x + width, y + 10), GRID, 1)
    cv2.rectangle(
        frame,
        (bar_x, y - 18),
        (bar_x + int(width * normalized), y + 10),
        color,
        -1,
    )
    draw_text(frame, label, x, y, 0.55, MUTED, 1)
    draw_text(
        frame,
        value_text if value_text is not None else f"{value:.5f}",
        bar_x + width - 92,
        y,
        0.48,
        TEXT,
        1,
    )


def draw_grid(frame: np.ndarray, x: int, y: int, width: int, height: int) -> None:
    cv2.rectangle(frame, (x, y), (x + width, y + height), (11, 15, 18), -1)
    for step in range(0, width + 1, max(1, width // 8)):
        cv2.line(frame, (x + step, y), (x + step, y + height), GRID, 1)
    for step in range(0, height + 1, max(1, height // 4)):
        cv2.line(frame, (x, y + step), (x + width, y + step), GRID, 1)


def draw_text(
    frame: np.ndarray,
    text: str,
    x: int,
    y: int,
    scale: float,
    color: tuple[int, int, int],
    thickness: int,
) -> None:
    cv2.putText(
        frame,
        text,
        (x, y),
        cv2.FONT_HERSHEY_SIMPLEX,
        scale,
        color,
        thickness,
        cv2.LINE_AA,
    )


def draw_wrapped_text(
    frame: np.ndarray,
    text: str,
    x: int,
    y: int,
    width: int,
    line_height: int,
    scale: float,
    color: tuple[int, int, int],
    thickness: int,
    max_lines: int,
) -> None:
    lines = wrap_text(text, width, scale, thickness, max_lines)
    for index, line in enumerate(lines):
        draw_text(frame, line, x, y + index * line_height, scale, color, thickness)


def wrap_text(
    text: str,
    width: int,
    scale: float,
    thickness: int,
    max_lines: int,
) -> list[str]:
    words = text.split()
    if not words:
        return []

    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        candidate_width = text_width(candidate, scale, thickness)
        if candidate_width <= width:
            current = candidate
            continue

        if current:
            lines.append(current)
            current = ""
            if len(lines) == max_lines:
                break

        if text_width(word, scale, thickness) <= width:
            current = word
        else:
            lines.append(trim_to_width(word, width, scale, thickness))
            current = ""
        if len(lines) == max_lines:
            break

    if current and len(lines) < max_lines:
        lines.append(current)

    if len(lines) == max_lines and len(" ".join(lines).split()) < len(words):
        lines[-1] = lines[-1].rstrip(".") + "..."

    return lines


def text_width(text: str, scale: float, thickness: int) -> int:
    return cv2.getTextSize(
        text,
        cv2.FONT_HERSHEY_SIMPLEX,
        scale,
        thickness,
    )[0][0]


def trim_to_width(text: str, width: int, scale: float, thickness: int) -> str:
    if text_width("...", scale, thickness) > width:
        return ""

    trimmed = text
    while trimmed:
        candidate = f"{trimmed}..."
        if text_width(candidate, scale, thickness) <= width:
            return candidate
        trimmed = trimmed[:-1].rstrip()
    return "..."


def shorten_path(path: Path) -> str:
    parts = path.parts
    if len(parts) <= 4:
        return str(path)
    return "/".join(parts[-4:])


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    raise SystemExit(run_voice_app())


if __name__ == "__main__":
    main()
