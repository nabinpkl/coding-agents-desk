"""Single-window dev console with a left sidebar to switch between the three
voice tools: the video clipper, the voice recorder, and the pronunciation
comparer.

Each tool is a View that draws into the main region to the right of the
sidebar and handles its own keys/mouse. Only the active view is live, so
on_enter/on_leave own resources (the recorder's mic stream, the clipper's
audio playback). Run with `just dev`.
"""

import argparse
import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import cv2
import numpy as np
import sounddevice as sd

from interaction_agent.paths import VIDEO_CLIP_ROOT, VOICE_RECORDING_ROOT
from interaction_agent.voice.clip_picker import (
    ARROW_DOWN,
    ARROW_LEFT,
    ARROW_RIGHT,
    ARROW_UP,
    AUDIO_SAMPLE_RATE,
    ENTER_KEYS,
    FAST_STEP_FRAMES,
    GREEN,
    MUTED,
    PANEL_BG,
    PLAY_CHUNK_SECONDS,
    RED,
    SEEK_DEBOUNCE_SECONDS,
    TEXT,
    WAVE_BG,
    WAVE_COLOR,
    YELLOW,
    VideoScrubber,
    WaveformStrip,
    cut_segment,
    decode_audio_segment,
    draw_text,
    find_videos,
    format_timecode,
)
from interaction_agent.voice.pronunciation import (
    PronunciationComparison,
    compare_recordings,
    load_wav,
)
from interaction_agent.voice.recording import VoiceInputRecorder
from interaction_agent.voice.signals import VoiceSignalFrame, analyze_audio


LOGGER = logging.getLogger("voice_agent.dev_console")

WINDOW_NAME: Final = "Interaction Dev Console"
WINDOW_WIDTH: Final = 1280
WINDOW_HEIGHT: Final = 760
SIDEBAR_WIDTH: Final = 190
ITEM_HEIGHT: Final = 56
ITEMS_TOP: Final = 84
CLIPPER_CONTROLS_HEIGHT: Final = 170
ACCENT: Final = (40, 50, 58)
SIGNAL_RESOLUTION: Final = 800
ALIGN_STEP_SECONDS: Final = 0.01
CENTROID_MAX_HZ: Final = 4000.0
WAVE_REFERENCE: Final = (90, 200, 120)
WAVE_LEARNER: Final = (250, 170, 60)
CENTROID_COLOR: Final = (230, 200, 90)
Region = tuple[int, int, int, int]


@dataclass(frozen=True)
class SignalView:
    envelope: np.ndarray
    centroid: np.ndarray
    duration: float
    mean_centroid: float


def clip_envelope(audio: np.ndarray, columns: int = SIGNAL_RESOLUTION) -> np.ndarray:
    values = np.zeros(columns, dtype=np.float32)
    if audio.size == 0:
        return values
    peak = float(np.max(np.abs(audio))) or 1.0
    edges = np.linspace(0, audio.size, columns + 1).astype(int)
    for column in range(columns):
        segment = audio[edges[column]:edges[column + 1]]
        if segment.size:
            values[column] = float(np.max(np.abs(segment))) / peak
    return values


def centroid_curve(frames: list[VoiceSignalFrame], columns: int = SIGNAL_RESOLUTION) -> np.ndarray:
    if not frames or columns <= 0:
        return np.zeros(columns, dtype=np.float32)
    values = np.array([frame.spectral_centroid_hz for frame in frames], dtype=np.float32)
    resampled = np.interp(
        np.linspace(0.0, values.size - 1, columns),
        np.arange(values.size),
        values,
    )
    return np.clip(resampled / CENTROID_MAX_HZ, 0.0, 1.0).astype(np.float32)


def build_signal_view(audio: np.ndarray, sample_rate: int) -> SignalView:
    analysis = analyze_audio(audio, sample_rate)
    return SignalView(
        envelope=clip_envelope(audio),
        centroid=centroid_curve(analysis.frames),
        duration=analysis.summary.duration_seconds,
        mean_centroid=analysis.summary.mean_spectral_centroid_hz,
    )


class View:
    name: str = "View"

    def on_enter(self) -> None:
        return None

    def on_leave(self) -> None:
        return None

    def tick(self) -> None:
        return None

    def render(self, canvas: np.ndarray, region: Region) -> None:
        return None

    def handle_key(self, code: int) -> None:
        return None

    def handle_mouse(self, event: int, x: int, y: int, region: Region) -> None:
        return None


def find_wavs(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(root.glob("*.wav"))


class ClipperView(View):
    name = "Clipper"

    def __init__(self, output_dir: Path = VIDEO_CLIP_ROOT) -> None:
        self.output_dir = output_dir
        self.videos = find_videos()
        self.video_index = 0
        self.scrubber: VideoScrubber | None = None
        self.waveform: WaveformStrip | None = None
        self.playing = False
        self.seeking = False
        self.last_seek_time = 0.0
        self.play_wall_start = 0.0
        self.play_frame_start = 0
        self.dragging = False
        self.status = ""
        if self.videos:
            self.load_video(0)

    def load_video(self, index: int) -> None:
        self.stop_play()
        if self.scrubber is not None:
            self.scrubber.release()
        self.video_index = index % len(self.videos)
        video = self.videos[self.video_index]
        self.scrubber = VideoScrubber(video)
        self.waveform = WaveformStrip(video)
        self.status = video.name

    def start_play(self) -> None:
        if self.scrubber is None:
            return
        samples = decode_audio_segment(
            self.videos[self.video_index],
            self.scrubber.seconds_at(self.scrubber.index),
            PLAY_CHUNK_SECONDS,
        )
        try:
            if samples.size:
                sd.play(samples, AUDIO_SAMPLE_RATE)
        except Exception as error:  # audio is best-effort
            LOGGER.warning("audio playback unavailable: %s", error)
        self.playing = True
        self.seeking = False
        self.play_wall_start = time.monotonic()
        self.play_frame_start = self.scrubber.index

    def begin_seek(self) -> None:
        if not self.seeking:
            try:
                sd.stop()
            except Exception:
                pass
        self.seeking = True
        self.last_seek_time = time.monotonic()

    def stop_play(self) -> None:
        self.playing = False
        self.seeking = False
        try:
            sd.stop()
        except Exception:
            pass

    def on_leave(self) -> None:
        self.stop_play()

    def tick(self) -> None:
        if self.scrubber is None:
            return
        if self.playing and self.seeking:
            if time.monotonic() - self.last_seek_time >= SEEK_DEBOUNCE_SECONDS:
                self.start_play()
        elif self.playing:
            elapsed = time.monotonic() - self.play_wall_start
            target = self.scrubber.clamp(self.play_frame_start + int(elapsed * self.scrubber.fps))
            while self.scrubber.index < target and self.scrubber.advance():
                pass
            if elapsed >= PLAY_CHUNK_SECONDS or self.scrubber.index >= self.scrubber.frame_count - 1:
                self.stop_play()
                self.status = "playback ended"

    def handle_key(self, code: int) -> None:
        if self.scrubber is None:
            return
        if code in ARROW_LEFT:
            self.scrubber.step(-1)
            self._nudge_audio()
        elif code in ARROW_RIGHT:
            self.scrubber.step(1)
            self._nudge_audio()
        elif code in ARROW_UP:
            self.scrubber.step(FAST_STEP_FRAMES)
            self._nudge_audio()
        elif code in ARROW_DOWN:
            self.scrubber.step(-FAST_STEP_FRAMES)
            self._nudge_audio()
        else:
            key = code & 0xFF
            if key == ord("i"):
                self.scrubber.in_index = self.scrubber.index
                self.status = f"in {format_timecode(self.scrubber.seconds_at(self.scrubber.index))}"
            elif key == ord("o"):
                self.scrubber.out_index = self.scrubber.index
                self.status = f"out {format_timecode(self.scrubber.seconds_at(self.scrubber.index))}"
            elif key == ord("c"):
                self.stop_play()
                self.status = cut_segment(self.scrubber, self.output_dir)
            elif key == ord("x"):
                self.scrubber.in_index = None
                self.scrubber.out_index = None
                self.status = "marks cleared"
            elif key == ord(" "):
                if self.playing:
                    self.stop_play()
                    self.status = "paused"
                else:
                    self.start_play()
                    self.status = "playing"
            elif key == ord("n") and len(self.videos) > 1:
                self.load_video(self.video_index + 1)

    def _nudge_audio(self) -> None:
        if self.playing:
            self.begin_seek()

    def handle_mouse(self, event: int, x: int, y: int, region: Region) -> None:
        if self.scrubber is None:
            return
        bar_x, bar_y, bar_w = self._seekbar_geometry(region)
        on_bar = bar_y - 10 <= y <= bar_y + 10 and bar_x <= x <= bar_x + bar_w
        if event == cv2.EVENT_LBUTTONDOWN and on_bar:
            self.dragging = True
            self._seek_to_fraction((x - bar_x) / max(1, bar_w))
        elif event == cv2.EVENT_MOUSEMOVE and self.dragging:
            self._seek_to_fraction((x - bar_x) / max(1, bar_w))
        elif event == cv2.EVENT_LBUTTONUP and self.dragging:
            self.dragging = False
            if self.playing:
                self.begin_seek()

    def _seek_to_fraction(self, fraction: float) -> None:
        if self.scrubber is None:
            return
        fraction = min(1.0, max(0.0, fraction))
        self.scrubber.seek(int(fraction * (self.scrubber.frame_count - 1)))

    def _seekbar_geometry(self, region: Region) -> tuple[int, int, int]:
        rx, _, rw, _ = region
        bar_x = rx + 16
        bar_w = rw - 32
        bar_y = self._bottom(region) - 84
        return bar_x, bar_y, bar_w

    def _bottom(self, region: Region) -> int:
        _, ry, _, rh = region
        return ry + rh

    def render(self, canvas: np.ndarray, region: Region) -> None:
        rx, ry, rw, rh = region
        if self.scrubber is None:
            draw_text(canvas, "no videos in data/videos", rx + 24, ry + 48, 0.7, RED)
            return

        video_area_height = rh - CLIPPER_CONTROLS_HEIGHT
        if self.scrubber.frame is not None:
            frame = self.scrubber.frame
            scale = min(rw / frame.shape[1], video_area_height / frame.shape[0])
            size = (max(1, int(frame.shape[1] * scale)), max(1, int(frame.shape[0] * scale)))
            resized = cv2.resize(frame, size)
            offset_x = rx + (rw - size[0]) // 2
            canvas[ry:ry + size[1], offset_x:offset_x + size[0]] = resized

        self._draw_waveform(canvas, region)
        self._draw_seekbar(canvas, region)

        center = self.scrubber.seconds_at(self.scrubber.index)
        in_mark = format_timecode(self.scrubber.seconds_at(self.scrubber.in_index)) if self.scrubber.in_index is not None else "--"
        out_mark = format_timecode(self.scrubber.seconds_at(self.scrubber.out_index)) if self.scrubber.out_index is not None else "--"
        mode = "PLAY" if self.playing else "PAUSE"
        bottom = ry + rh
        draw_text(canvas, f"{mode}  {format_timecode(center)}  frame {self.scrubber.index}/{self.scrubber.frame_count - 1}", rx + 16, bottom - 56, 0.55, TEXT)
        draw_text(canvas, f"IN {in_mark}   OUT {out_mark}   {self.status}", rx + 16, bottom - 34, 0.55, GREEN)
        draw_text(canvas, "<-/-> frame  up/down fast  i in  o out  c cut  x clear  space play  n next video", rx + 16, bottom - 12, 0.48, MUTED)

    def _draw_waveform(self, canvas: np.ndarray, region: Region) -> None:
        if self.waveform is None or self.scrubber is None:
            return
        rx, ry, rw, rh = region
        top = ry + rh - CLIPPER_CONTROLS_HEIGHT + 8
        height = 64
        bottom = top + height
        middle = (top + bottom) // 2
        half = height // 2 - 4
        center = self.scrubber.seconds_at(self.scrubber.index)
        self.waveform.ensure_region(center)
        cv2.rectangle(canvas, (rx + 8, top), (rx + rw - 8, bottom), WAVE_BG, -1)
        values = self.waveform.envelope(center, rw - 16)
        for offset in range(values.size):
            bar = int(values[offset] * half)
            if bar > 0:
                column = rx + 8 + offset
                cv2.line(canvas, (column, middle - bar), (column, middle + bar), WAVE_COLOR, 1)
        cv2.line(canvas, (rx + 8 + (rw - 16) // 2, top), (rx + 8 + (rw - 16) // 2, bottom), YELLOW, 1)

    def _draw_seekbar(self, canvas: np.ndarray, region: Region) -> None:
        if self.scrubber is None:
            return
        bar_x, bar_y, bar_w = self._seekbar_geometry(region)
        cv2.line(canvas, (bar_x, bar_y), (bar_x + bar_w, bar_y), ACCENT, 4)
        fraction = self.scrubber.index / max(1, self.scrubber.frame_count - 1)
        head = bar_x + int(fraction * bar_w)
        cv2.line(canvas, (bar_x, bar_y), (head, bar_y), GREEN, 4)
        cv2.circle(canvas, (head, bar_y), 6, YELLOW, -1)
        for mark, color in ((self.scrubber.in_index, GREEN), (self.scrubber.out_index, RED)):
            if mark is not None:
                position = bar_x + int(mark / max(1, self.scrubber.frame_count - 1) * bar_w)
                cv2.line(canvas, (position, bar_y - 8), (position, bar_y + 8), color, 2)


class RecorderView(View):
    name = "Recorder"

    def __init__(self) -> None:
        self.recorder = VoiceInputRecorder()
        self.streaming = False
        self.status = "press r to record"

    def on_enter(self) -> None:
        try:
            self.recorder.start_stream()
            self.streaming = True
        except Exception as error:
            self.status = f"mic unavailable: {error}"
            LOGGER.warning("microphone unavailable: %s", error)

    def on_leave(self) -> None:
        if self.streaming:
            try:
                self.recorder.stop_stream()
            except Exception:
                pass
            self.streaming = False

    def handle_key(self, code: int) -> None:
        if (code & 0xFF) == ord("r"):
            result = self.recorder.toggle_recording()
            if result is not None:
                self.status = f"saved {result.wav_path.name}"

    def render(self, canvas: np.ndarray, region: Region) -> None:
        rx, ry, rw, rh = region
        snapshot = self.recorder.snapshot()
        draw_text(canvas, "Voice Recorder", rx + 24, ry + 44, 0.8, TEXT)
        draw_text(canvas, f"device: {snapshot.input_device_name}", rx + 24, ry + 80, 0.55, MUTED)
        draw_text(canvas, f"sample rate: {snapshot.sample_rate} Hz   dropped: {snapshot.dropped_blocks}", rx + 24, ry + 104, 0.55, MUTED)

        self._draw_meter(canvas, rx + 24, ry + 150, rw - 48, "RMS", snapshot.rms, GREEN)
        self._draw_meter(canvas, rx + 24, ry + 196, rw - 48, "PEAK", snapshot.peak, YELLOW)

        if snapshot.is_recording:
            cv2.circle(canvas, (rx + 36, ry + 264), 10, RED, -1)
            draw_text(canvas, f"REC  {snapshot.recording_seconds:5.1f}s", rx + 56, ry + 272, 0.7, RED)
        elif snapshot.is_monitoring:
            cv2.circle(canvas, (rx + 36, ry + 264), 10, YELLOW, -1)
            draw_text(canvas, f"MON  {snapshot.recording_seconds:5.1f}s", rx + 56, ry + 272, 0.7, YELLOW)
        else:
            draw_text(canvas, "idle", rx + 24, ry + 272, 0.7, MUTED)

        self._draw_history(canvas, rx + 24, ry + 320, rw - 48, 120, snapshot.recent_rms)
        draw_text(canvas, self.status, rx + 24, ry + rh - 40, 0.6, TEXT)
        draw_text(canvas, "r start/stop recording  (saves to data/voice/recordings)", rx + 24, ry + rh - 14, 0.5, MUTED)

    def _draw_meter(self, canvas: np.ndarray, x: int, y: int, width: int, label: str, value: float, color: tuple[int, int, int]) -> None:
        draw_text(canvas, label, x, y - 6, 0.5, MUTED)
        cv2.rectangle(canvas, (x + 70, y - 20), (x + width, y - 2), ACCENT, -1)
        filled = int(min(1.0, value * 3.0) * (width - 70))
        cv2.rectangle(canvas, (x + 70, y - 20), (x + 70 + max(0, filled), y - 2), color, -1)

    def _draw_history(self, canvas: np.ndarray, x: int, y: int, width: int, height: int, history: tuple[float, ...]) -> None:
        cv2.rectangle(canvas, (x, y), (x + width, y + height), WAVE_BG, -1)
        if not history:
            return
        peak = max(history) or 1.0
        bars = min(len(history), width)
        for index in range(bars):
            value = history[len(history) - bars + index] / peak
            bar = int(value * (height - 8))
            column = x + index
            cv2.line(canvas, (column, y + height - 4), (column, y + height - 4 - bar), WAVE_COLOR, 1)


class ComparerView(View):
    name = "Comparer"

    def __init__(self) -> None:
        self.references: list[Path] = []
        self.recordings: list[Path] = []
        self.reference_index = 0
        self.recording_index = 0
        self.active_column = 0
        self.result: PronunciationComparison | None = None
        self.reference_view: SignalView | None = None
        self.learner_view: SignalView | None = None
        self.reference_audio = np.zeros(0, dtype=np.float32)
        self.learner_audio = np.zeros(0, dtype=np.float32)
        self.reference_rate = 0
        self.learner_rate = 0
        self.cost = np.zeros(0, dtype=np.float32)
        self.playing_mode: str | None = None
        self.play_start = 0.0
        self.align_offset_seconds = 0.0
        self.dragging = False
        self.drag_last_x = 0
        self.status = "tab switch column, up/down move, c compare"

    def on_leave(self) -> None:
        try:
            sd.stop()
        except Exception:
            pass

    def on_enter(self) -> None:
        self.references = find_wavs(VIDEO_CLIP_ROOT)
        self.recordings = find_wavs(VOICE_RECORDING_ROOT)
        self.reference_index = min(self.reference_index, max(0, len(self.references) - 1))
        self.recording_index = min(self.recording_index, max(0, len(self.recordings) - 1))

    def handle_key(self, code: int) -> None:
        column = self.references if self.active_column == 0 else self.recordings
        if code in ARROW_UP and column:
            self._move(-1, len(column))
        elif code in ARROW_DOWN and column:
            self._move(1, len(column))
        elif code in ARROW_LEFT:
            self.align_offset_seconds -= ALIGN_STEP_SECONDS
        elif code in ARROW_RIGHT:
            self.align_offset_seconds += ALIGN_STEP_SECONDS
        else:
            key = code & 0xFF
            if key == ord("\t") or key == 9:
                self.active_column = 1 - self.active_column
            elif key == ord("c") or key in ENTER_KEYS:
                self._compare()
            elif key == ord("x"):
                self._clear()
            elif key == ord("r"):
                self._play(self.reference_audio, self.reference_rate, "reference")
            elif key == ord("y"):
                self._play(self.learner_audio, self.learner_rate, "learner")
            elif key == ord(" "):
                self._play_both()
            elif key == ord("s"):
                self._stop_audio()
            elif key == ord("0"):
                self.align_offset_seconds = 0.0

    def _move(self, delta: int, length: int) -> None:
        if self.active_column == 0:
            self.reference_index = (self.reference_index + delta) % length
        else:
            self.recording_index = (self.recording_index + delta) % length

    def _clear(self) -> None:
        self._stop_audio()
        self.result = None
        self.reference_view = None
        self.learner_view = None
        self.reference_audio = np.zeros(0, dtype=np.float32)
        self.learner_audio = np.zeros(0, dtype=np.float32)
        self.cost = np.zeros(0, dtype=np.float32)
        self.align_offset_seconds = 0.0
        self.status = "cleared"

    def _compare(self) -> None:
        if not self.references or not self.recordings:
            self.status = "need a clip and a recording"
            return
        reference = self.references[self.reference_index]
        learner = self.recordings[self.recording_index]
        try:
            self.reference_audio, self.reference_rate = load_wav(reference)
            self.learner_audio, self.learner_rate = load_wav(learner)
            self.result = compare_recordings(reference, learner)
            self.reference_view = build_signal_view(self.reference_audio, self.reference_rate)
            self.learner_view = build_signal_view(self.learner_audio, self.learner_rate)
            self.cost = np.array([step.cost for step in self.result.trace], dtype=np.float32)
            self.status = f"distance {self.result.distance:.3f}   closeness {self.result.closeness:.2f}"
        except Exception as error:
            self._clear()
            self.status = f"compare failed: {error}"

    def _stop_audio(self) -> None:
        self.playing_mode = None
        try:
            sd.stop()
        except Exception:
            pass

    def _play(self, audio: np.ndarray, sample_rate: int, mode: str) -> None:
        if audio.size == 0 or sample_rate <= 0:
            self.status = "compare first (press c) to load audio"
            return
        try:
            sd.stop()
            sd.play(audio, sample_rate)
        except Exception as error:  # audio is best-effort
            LOGGER.warning("audio playback unavailable: %s", error)
            self.status = f"audio error: {error}"
            return
        self.playing_mode = mode
        self.play_start = time.monotonic()
        self.status = f"playing {mode}"

    def _play_both(self) -> None:
        if self.reference_audio.size == 0 or self.learner_audio.size == 0:
            self.status = "compare first (press c) to load audio"
            return
        if self.reference_rate != self.learner_rate:
            # different sample rates cannot share one stereo stream; play in turn
            self._play(self.reference_audio, self.reference_rate, "reference")
            return
        offset_samples = int(self.align_offset_seconds * self.reference_rate)
        reference_start = max(0, -offset_samples)
        learner_start = max(0, offset_samples)
        length = max(reference_start + self.reference_audio.size, learner_start + self.learner_audio.size)
        left = np.zeros(length, dtype=np.float32)
        right = np.zeros(length, dtype=np.float32)
        left[reference_start:reference_start + self.reference_audio.size] = self.reference_audio
        right[learner_start:learner_start + self.learner_audio.size] = self.learner_audio
        self._play(np.stack([left, right], axis=1), self.reference_rate, "both")

    def render(self, canvas: np.ndarray, region: Region) -> None:
        rx, ry, rw, rh = region
        column_width = (rw - 48) // 2
        self._draw_list(canvas, rx + 16, ry + 12, column_width, "REFERENCE (clips)", self.references, self.reference_index, self.active_column == 0)
        self._draw_list(canvas, rx + 32 + column_width, ry + 12, column_width, "RECORDING (your voice)", self.recordings, self.recording_index, self.active_column == 1)

        draw_text(canvas, self.status, rx + 16, ry + 214, 0.6, TEXT)
        legend = "tab column  up/down move  c compare  x clear  |  r/y/space play  s stop  |  drag or <-/-> align  0 reset"
        draw_text(canvas, legend, rx + 16, ry + rh - 10, 0.42, MUTED)

        if self.reference_view is None or self.learner_view is None:
            return
        reference_rect, learner_rect, cost_rect, pps = self._layout(region)
        offset_px = int(self.align_offset_seconds * pps)
        reference_width = max(1, int(self.reference_view.duration * pps))
        learner_width = max(1, int(self.learner_view.duration * pps))
        reference_head, learner_head = self._playheads(reference_rect[0], pps)
        self._draw_signal_panel(canvas, reference_rect, "reference", self.reference_view, WAVE_REFERENCE, reference_rect[0], reference_width, reference_head)
        self._draw_signal_panel(canvas, learner_rect, f"your voice  offset {self.align_offset_seconds:+.2f}s", self.learner_view, WAVE_LEARNER, learner_rect[0] + offset_px, learner_width, learner_head)
        self._draw_cost_panel(canvas, cost_rect)

    def _layout(self, region: Region) -> tuple[Region, Region, Region, float]:
        rx, ry, rw, rh = region
        panel_top = ry + 230
        panel_height = ((ry + rh - 24) - panel_top - 16) // 3
        x = rx + 16
        width = rw - 32
        reference_rect = (x, panel_top, width, panel_height)
        learner_rect = (x, panel_top + panel_height + 8, width, panel_height)
        cost_rect = (x, panel_top + 2 * (panel_height + 8), width, panel_height)
        span = 1.0
        if self.reference_view is not None and self.learner_view is not None:
            span = max(self.reference_view.duration, self.learner_view.duration, 1e-3)
        return reference_rect, learner_rect, cost_rect, width / span

    def _playheads(self, base_x: int, pps: float) -> tuple[int | None, int | None]:
        if self.playing_mode is None or self.reference_view is None or self.learner_view is None:
            return None, None
        elapsed = time.monotonic() - self.play_start
        offset = self.align_offset_seconds
        reference_head: int | None = None
        learner_head: int | None = None
        if self.playing_mode == "reference" and 0.0 <= elapsed <= self.reference_view.duration:
            reference_head = base_x + int(elapsed * pps)
        elif self.playing_mode == "learner" and 0.0 <= elapsed <= self.learner_view.duration:
            learner_head = base_x + int((offset + elapsed) * pps)
        elif self.playing_mode == "both":
            total = max(self.reference_view.duration + max(0.0, -offset), self.learner_view.duration + max(0.0, offset))
            if 0.0 <= elapsed <= total:
                shared = base_x + int((elapsed + min(0.0, offset)) * pps)
                reference_head = shared
                learner_head = shared
        if reference_head is None and learner_head is None:
            self.playing_mode = None
        return reference_head, learner_head

    def handle_mouse(self, event: int, x: int, y: int, region: Region) -> None:
        if self.reference_view is None or self.learner_view is None:
            return
        _, learner_rect, _, pps = self._layout(region)
        lx, ly, lw, lh = learner_rect
        if event == cv2.EVENT_LBUTTONDOWN and lx <= x <= lx + lw and ly <= y <= ly + lh:
            self.dragging = True
            self.drag_last_x = x
        elif event == cv2.EVENT_MOUSEMOVE and self.dragging and pps > 0:
            self.align_offset_seconds += (x - self.drag_last_x) / pps
            self.drag_last_x = x
        elif event == cv2.EVENT_LBUTTONUP:
            self.dragging = False

    def _draw_signal_panel(self, canvas: np.ndarray, rect: Region, title: str, view: SignalView, wave_color: tuple[int, int, int], wave_x: int, wave_width: int, playhead: int | None) -> None:
        x, y, width, height = rect
        cv2.rectangle(canvas, (x, y), (x + width, y + height), WAVE_BG, -1)
        middle = y + height // 2
        half = height // 2 - 6
        size = view.envelope.size
        for column in range(wave_width):
            position = wave_x + column
            if position < x or position >= x + width:
                continue
            value = view.envelope[min(size - 1, column * size // wave_width)]
            bar = int(value * half)
            if bar > 0:
                cv2.line(canvas, (position, middle - bar), (position, middle + bar), wave_color, 1)
        previous: tuple[int, int] | None = None
        for column in range(0, wave_width, 2):
            position = wave_x + column
            if position < x or position >= x + width:
                previous = None
                continue
            value = view.centroid[min(view.centroid.size - 1, column * view.centroid.size // wave_width)]
            point = (position, y + height - 4 - int(value * (height - 8)))
            if previous is not None:
                cv2.line(canvas, previous, point, CENTROID_COLOR, 1)
            previous = point
        if playhead is not None and x <= playhead <= x + width:
            cv2.line(canvas, (playhead, y), (playhead, y + height), (245, 245, 245), 1)
        draw_text(canvas, f"{title}  {view.duration:.2f}s  centroid {view.mean_centroid:.0f}Hz", x + 8, y + 18, 0.46, TEXT)

    def _draw_cost_panel(self, canvas: np.ndarray, rect: Region) -> None:
        x, y, width, height = rect
        cv2.rectangle(canvas, (x, y), (x + width, y + height), WAVE_BG, -1)
        draw_text(canvas, "divergence (DTW cost along alignment)", x + 8, y + 18, 0.46, TEXT)
        if self.cost.size == 0:
            return
        peak = float(self.cost.max()) or 1.0
        previous: tuple[int, int] | None = None
        for column in range(width):
            value = self.cost[min(self.cost.size - 1, column * self.cost.size // width)]
            point = (x + column, y + height - 4 - int(value / peak * (height - 24)))
            if previous is not None:
                cv2.line(canvas, previous, point, RED, 1)
            previous = point

    def _draw_list(self, canvas: np.ndarray, x: int, y: int, width: int, title: str, items: list[Path], selected: int, active: bool) -> None:
        draw_text(canvas, title, x, y + 20, 0.55, TEXT if active else MUTED)
        if not items:
            draw_text(canvas, "(none)", x + 8, y + 52, 0.5, MUTED)
            return
        visible = min(len(items), 6)
        first = max(0, min(selected - visible // 2, len(items) - visible))
        for row in range(visible):
            index = first + row
            top = y + 40 + row * 26
            if index == selected:
                color = GREEN if active else MUTED
                cv2.rectangle(canvas, (x, top - 18), (x + width, top + 6), ACCENT, -1)
            else:
                color = MUTED
            label = items[index].name
            if len(label) > 46:
                label = label[:43] + "..."
            draw_text(canvas, label, x + 8, top, 0.46, color)


class DevConsole:
    def __init__(self, output_dir: Path = VIDEO_CLIP_ROOT) -> None:
        self.views: list[View] = [ClipperView(output_dir), RecorderView(), ComparerView()]
        self.active = 0

    def region(self) -> Region:
        return (SIDEBAR_WIDTH, 0, WINDOW_WIDTH - SIDEBAR_WIDTH, WINDOW_HEIGHT)

    def switch(self, index: int) -> None:
        if index == self.active or not 0 <= index < len(self.views):
            return
        self.views[self.active].on_leave()
        self.active = index
        self.views[self.active].on_enter()

    def on_mouse(self, event: int, x: int, y: int, flags: int, param: object) -> None:
        if event == cv2.EVENT_LBUTTONDOWN and x < SIDEBAR_WIDTH:
            index = (y - ITEMS_TOP) // ITEM_HEIGHT
            if y >= ITEMS_TOP and 0 <= index < len(self.views):
                self.switch(index)
            return
        self.views[self.active].handle_mouse(event, x, y, self.region())

    def draw_sidebar(self, canvas: np.ndarray) -> None:
        cv2.rectangle(canvas, (0, 0), (SIDEBAR_WIDTH, WINDOW_HEIGHT), (24, 30, 36), -1)
        draw_text(canvas, "DEV CONSOLE", 18, 48, 0.6, TEXT)
        for index, view in enumerate(self.views):
            top = ITEMS_TOP + index * ITEM_HEIGHT
            if index == self.active:
                cv2.rectangle(canvas, (0, top), (SIDEBAR_WIDTH, top + ITEM_HEIGHT - 6), ACCENT, -1)
            color = GREEN if index == self.active else MUTED
            draw_text(canvas, f"{index + 1}  {view.name}", 18, top + 34, 0.6, color)
        draw_text(canvas, "1/2/3 or click", 18, WINDOW_HEIGHT - 56, 0.46, MUTED)
        draw_text(canvas, "tab cycle", 18, WINDOW_HEIGHT - 34, 0.46, MUTED)
        draw_text(canvas, "q quit", 18, WINDOW_HEIGHT - 12, 0.46, MUTED)

    def run(self) -> int:
        cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(WINDOW_NAME, WINDOW_WIDTH, WINDOW_HEIGHT)
        cv2.setMouseCallback(WINDOW_NAME, self.on_mouse)
        self.views[self.active].on_enter()
        try:
            while True:
                canvas = np.full((WINDOW_HEIGHT, WINDOW_WIDTH, 3), PANEL_BG, np.uint8)
                view = self.views[self.active]
                view.tick()
                view.render(canvas, self.region())
                self.draw_sidebar(canvas)
                cv2.imshow(WINDOW_NAME, canvas)

                code = cv2.waitKeyEx(15)
                if code == -1:
                    continue
                key = code & 0xFF
                if key in (ord("1"), ord("2"), ord("3")):
                    self.switch(key - ord("1"))
                elif key == 9 or key == ord("\t"):
                    self.switch((self.active + 1) % len(self.views))
                elif key in (ord("q"), 27):
                    return 0
                else:
                    view.handle_key(code)
        finally:
            self.views[self.active].on_leave()
            cv2.destroyAllWindows()


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Voice tooling dev console (clipper, recorder, comparer).")
    parser.add_argument("--output-dir", type=Path, default=VIDEO_CLIP_ROOT, help="directory for clip outputs")
    arguments = parser.parse_args()
    try:
        return DevConsole(arguments.output_dir).run()
    except Exception as error:
        print(f"dev console failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
