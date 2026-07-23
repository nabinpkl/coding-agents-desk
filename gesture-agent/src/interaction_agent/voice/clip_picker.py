"""Interactive OpenCV scrubber for picking frame-precise cut points.

Scrub a source video frame by frame, mark in/out, and cut a segment straight
through the existing pipeline (mp4 + 16kHz wav via clips.extract_clip). Each
cut also prints the equivalent `just clip` command so the pick is reproducible.

Controls:
    left / right    step one frame back / forward
    up / down       fast step forward / back (FAST_STEP_FRAMES frames)
    i / o           mark in / out at the current frame
    c               cut the marked segment (mp4 + 16kHz wav)
    x               clear the in/out marks
    space           play / pause (audio via sounddevice, video follows)
    q or esc        quit

Arrow keys are read with cv2.waitKeyEx; their codes are backend-specific, so a
few known per-platform values are matched. OpenCV's macOS GUI does not expose
the Shift modifier, which is why up/down (not Shift+arrow) drive fast stepping.

OpenCV cannot play audio, so on play the audio track is decoded from the
current position with ffmpeg and played through sounddevice; the video frames
are advanced against a wall clock so they track the audio (best-effort sync).
"""

import argparse
import logging
import subprocess
import sys
import time
from pathlib import Path
from typing import Final

import cv2
import numpy as np
import sounddevice as sd

from interaction_agent.paths import VIDEO_CLIP_ROOT, VIDEO_DATA_ROOT
from interaction_agent.voice.clips import extract_clip


LOGGER = logging.getLogger("voice_agent.clip_picker")

WINDOW_NAME: Final = "Clip Picker"
CHOOSER_NAME: Final = "Select a video"
TRACKBAR_NAME: Final = "frame"
FAST_STEP_FRAMES: Final = 10
DEFAULT_FPS: Final = 30.0
AUDIO_SAMPLE_RATE: Final = 22050
PLAY_CHUNK_SECONDS: Final = 120.0
SEEK_DEBOUNCE_SECONDS: Final = 0.18

WAVEFORM_WINDOW_SECONDS: Final = 6.0
WAVEFORM_REGION_SECONDS: Final = 45.0
WAVEFORM_HEIGHT: Final = 80
WAVE_BG: Final = (12, 16, 20)
WAVE_COLOR: Final = (90, 200, 120)
VIDEO_EXTENSIONS: Final = frozenset({".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"})
ENTER_KEYS: Final = frozenset({13, 10})

PANEL_BG: Final = (18, 23, 28)
TEXT: Final = (235, 241, 245)
MUTED: Final = (160, 170, 178)
GREEN: Final = (80, 245, 140)
YELLOW: Final = (70, 205, 250)
RED: Final = (60, 80, 255)

# cv2.waitKeyEx arrow codes by platform (macOS cocoa, Linux Qt/GTK, Windows).
ARROW_LEFT: Final = frozenset({63234, 65361, 2424832})
ARROW_RIGHT: Final = frozenset({63235, 65363, 2555904})
ARROW_UP: Final = frozenset({63232, 65362, 2490368})
ARROW_DOWN: Final = frozenset({63233, 65364, 2621440})


def format_timecode(seconds: float) -> str:
    total = int(seconds)
    milliseconds = int(round((seconds - total) * 1000))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"


class VideoScrubber:
    def __init__(self, video_path: Path) -> None:
        self.video_path = video_path
        self.capture = cv2.VideoCapture(str(video_path))
        if not self.capture.isOpened():
            raise RuntimeError(f"could not open video: {video_path}")

        self.frame_count = int(self.capture.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = float(self.capture.get(cv2.CAP_PROP_FPS))
        self.fps = fps if fps > 0 else DEFAULT_FPS
        self.index = 0
        self.frame: np.ndarray | None = None
        self.in_index: int | None = None
        self.out_index: int | None = None
        self.seek(0)

    def clamp(self, index: int) -> int:
        return max(0, min(self.frame_count - 1, index))

    def seek(self, index: int) -> None:
        index = self.clamp(index)
        self.capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        read, frame = self.capture.read()
        if read:
            self.frame = frame
            self.index = index

    def step(self, delta: int) -> None:
        self.seek(self.index + delta)

    def advance(self) -> bool:
        read, frame = self.capture.read()
        if read:
            self.frame = frame
            self.index += 1
            return True
        return False

    def seconds_at(self, index: int) -> float:
        return index / self.fps

    def release(self) -> None:
        self.capture.release()


def decode_audio_segment(video_path: Path, start_seconds: float, duration_seconds: float) -> np.ndarray:
    completed = subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "quiet",
            "-ss",
            f"{start_seconds}",
            "-t",
            f"{duration_seconds}",
            "-i",
            str(video_path),
            "-vn",
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            str(AUDIO_SAMPLE_RATE),
            "-",
        ],
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout:
        return np.zeros(0, dtype=np.float32)
    return (np.frombuffer(completed.stdout, dtype=np.int16).astype(np.float32) / 32768.0).copy()


class WaveformStrip:
    """Scrolling audio envelope around the playhead so speech bursts are visible.

    Audio is decoded for a region centered on the playhead and cached; the
    visible window (a slice of that region) is re-bucketed each frame. The
    playhead stays at the strip center and the waveform scrolls underneath.
    """

    def __init__(self, video_path: Path) -> None:
        self.video_path = video_path
        self.region_start = 0.0
        self.region_samples = np.zeros(0, dtype=np.float32)

    def ensure_region(self, center_seconds: float) -> None:
        visible_low = center_seconds - WAVEFORM_WINDOW_SECONDS
        visible_high = center_seconds + WAVEFORM_WINDOW_SECONDS
        region_high = self.region_start + WAVEFORM_REGION_SECONDS
        if self.region_samples.size == 0 or visible_low < self.region_start or visible_high > region_high:
            self.region_start = max(0.0, center_seconds - WAVEFORM_REGION_SECONDS / 2.0)
            self.region_samples = decode_audio_segment(self.video_path, self.region_start, WAVEFORM_REGION_SECONDS)

    def envelope(self, center_seconds: float, columns: int) -> np.ndarray:
        values = np.zeros(max(0, columns), dtype=np.float32)
        if self.region_samples.size == 0 or columns <= 0:
            return values
        span = 2.0 * WAVEFORM_WINDOW_SECONDS
        visible_low = center_seconds - WAVEFORM_WINDOW_SECONDS
        peak = float(np.max(np.abs(self.region_samples))) or 1.0
        for column in range(columns):
            start = visible_low + (column / columns) * span
            end = visible_low + ((column + 1) / columns) * span
            low = max(0, int((start - self.region_start) * AUDIO_SAMPLE_RATE))
            high = min(self.region_samples.size, int((end - self.region_start) * AUDIO_SAMPLE_RATE))
            if high > low:
                values[column] = float(np.max(np.abs(self.region_samples[low:high]))) / peak
        return values

    def draw(self, canvas: np.ndarray, center_seconds: float, in_seconds: float | None, out_seconds: float | None) -> None:
        height, width = canvas.shape[:2]
        top = height - 96 - WAVEFORM_HEIGHT - 6
        bottom = top + WAVEFORM_HEIGHT
        middle = (top + bottom) // 2
        half = WAVEFORM_HEIGHT // 2 - 4

        self.ensure_region(center_seconds)
        cv2.rectangle(canvas, (0, top), (width, bottom), WAVE_BG, -1)
        values = self.envelope(center_seconds, width)
        for x in range(width):
            bar = int(values[x] * half)
            if bar > 0:
                cv2.line(canvas, (x, middle - bar), (x, middle + bar), WAVE_COLOR, 1)

        span = 2.0 * WAVEFORM_WINDOW_SECONDS
        visible_low = center_seconds - WAVEFORM_WINDOW_SECONDS
        for mark, color in ((in_seconds, GREEN), (out_seconds, RED)):
            if mark is not None and visible_low <= mark <= visible_low + span:
                position = int((mark - visible_low) / span * width)
                cv2.line(canvas, (position, top), (position, bottom), color, 1)
        cv2.line(canvas, (width // 2, top), (width // 2, bottom), YELLOW, 1)


def cut_segment(scrubber: VideoScrubber, output_dir: Path) -> str:
    if scrubber.in_index is None or scrubber.out_index is None:
        return "cut needs both in (i) and out (o) marks"
    if scrubber.out_index <= scrubber.in_index:
        return "cut needs out after in"

    start = scrubber.seconds_at(scrubber.in_index)
    end = scrubber.seconds_at(scrubber.out_index)
    result = extract_clip(scrubber.video_path, start, end, output_dir)
    command = f'just clip "{scrubber.video_path}" {format_timecode(start)} {format_timecode(end)}'
    print(command)
    print(f"  mp4: {result.mp4_path}")
    print(f"  wav: {result.wav_path}")
    return f"saved {result.mp4_path.name}"


def draw_overlay(canvas: np.ndarray, scrubber: VideoScrubber, status: str, playing: bool) -> None:
    height, width = canvas.shape[:2]
    panel = canvas.copy()
    cv2.rectangle(panel, (0, height - 96), (width, height), PANEL_BG, -1)
    cv2.addWeighted(panel, 0.72, canvas, 0.28, 0, canvas)

    current = f"{format_timecode(scrubber.seconds_at(scrubber.index))}  frame {scrubber.index}/{scrubber.frame_count - 1}  {scrubber.fps:.2f} fps"
    in_mark = format_timecode(scrubber.seconds_at(scrubber.in_index)) if scrubber.in_index is not None else "--"
    out_mark = format_timecode(scrubber.seconds_at(scrubber.out_index)) if scrubber.out_index is not None else "--"
    if scrubber.in_index is not None and scrubber.out_index is not None and scrubber.out_index > scrubber.in_index:
        duration = format_timecode(scrubber.seconds_at(scrubber.out_index - scrubber.in_index))
    else:
        duration = "--"

    mode = "PLAY" if playing else "PAUSE"
    draw_text(canvas, f"{mode}  {current}", 16, height - 64, 0.6, TEXT)
    draw_text(canvas, f"IN {in_mark}    OUT {out_mark}    DUR {duration}", 16, height - 38, 0.6, GREEN)
    legend = "<-/->frame  up/down fast  i in  o out  c cut  x clear  space play  q quit"
    draw_text(canvas, legend, 16, height - 14, 0.5, MUTED)
    if status:
        draw_text(canvas, status, 16, 28, 0.6, YELLOW)


def draw_text(canvas: np.ndarray, text: str, x: int, y: int, scale: float, color: tuple[int, int, int]) -> None:
    cv2.putText(canvas, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


def find_videos(root: Path = VIDEO_DATA_ROOT) -> list[Path]:
    if not root.exists():
        return []
    videos = [
        path
        for path in root.rglob("*")
        if path.suffix.lower() in VIDEO_EXTENSIONS and VIDEO_CLIP_ROOT not in path.parents
    ]
    return sorted(videos)


def choose_video(videos: list[Path]) -> Path | None:
    selected = 0
    width = 1000
    row_height = 34
    height = 96 + row_height * len(videos)
    cv2.namedWindow(CHOOSER_NAME, cv2.WINDOW_NORMAL)
    try:
        while True:
            canvas = np.full((height, width, 3), PANEL_BG, np.uint8)
            draw_text(canvas, "Select a video  (up/down move, enter pick, 1-9 quick, q cancel)", 16, 40, 0.6, TEXT)
            for index, video in enumerate(videos):
                top = 72 + index * row_height
                color = GREEN if index == selected else MUTED
                if index == selected:
                    cv2.rectangle(canvas, (8, top - 22), (width - 8, top + 8), (40, 50, 58), -1)
                label = video.name if len(video.name) <= 96 else video.name[:93] + "..."
                draw_text(canvas, f"{index + 1:>2}  {label}", 16, top, 0.55, color)
            cv2.imshow(CHOOSER_NAME, canvas)

            code = cv2.waitKeyEx(16)
            if code in ARROW_UP:
                selected = (selected - 1) % len(videos)
            elif code in ARROW_DOWN:
                selected = (selected + 1) % len(videos)
            elif code == -1:
                continue
            else:
                key = code & 0xFF
                if key in ENTER_KEYS or key == ord(" "):
                    return videos[selected]
                if key in (ord("q"), 27):
                    return None
                if ord("1") <= key <= ord("9") and key - ord("1") < len(videos):
                    return videos[key - ord("1")]
    finally:
        cv2.destroyWindow(CHOOSER_NAME)


def run_clip_picker(video_path: Path, output_dir: Path = VIDEO_CLIP_ROOT) -> int:
    scrubber = VideoScrubber(video_path)
    waveform = WaveformStrip(video_path)

    def on_trackbar(position: int) -> None:
        if position != scrubber.index:
            scrubber.seek(position)

    playing = False
    seeking = False
    last_seek_time = 0.0
    play_wall_start = 0.0
    play_frame_start = 0
    status = ""

    def start_play() -> str:
        nonlocal playing, seeking, play_wall_start, play_frame_start
        samples = decode_audio_segment(video_path, scrubber.seconds_at(scrubber.index), PLAY_CHUNK_SECONDS)
        try:
            if samples.size:
                sd.play(samples, AUDIO_SAMPLE_RATE)
        except Exception as error:  # audio is best-effort; video still plays
            LOGGER.warning("audio playback unavailable: %s", error)
        playing = True
        seeking = False
        play_wall_start = time.monotonic()
        play_frame_start = scrubber.index
        return "playing"

    def begin_seek() -> None:
        # While playing, coalesce a burst of arrow taps: mute now, resync audio
        # once the taps settle (see SEEK_DEBOUNCE_SECONDS) instead of per tap.
        nonlocal seeking, last_seek_time
        if not seeking:
            try:
                sd.stop()
            except Exception:
                pass
        seeking = True
        last_seek_time = time.monotonic()

    def stop_play() -> None:
        nonlocal playing, seeking
        playing = False
        seeking = False
        try:
            sd.stop()
        except Exception:
            pass

    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
    cv2.createTrackbar(TRACKBAR_NAME, WINDOW_NAME, 0, max(1, scrubber.frame_count - 1), on_trackbar)
    try:
        while True:
            canvas = scrubber.frame.copy() if scrubber.frame is not None else np.full((720, 1280, 3), PANEL_BG, np.uint8)
            in_seconds = scrubber.seconds_at(scrubber.in_index) if scrubber.in_index is not None else None
            out_seconds = scrubber.seconds_at(scrubber.out_index) if scrubber.out_index is not None else None
            waveform.draw(canvas, scrubber.seconds_at(scrubber.index), in_seconds, out_seconds)
            draw_overlay(canvas, scrubber, status, playing)
            cv2.imshow(WINDOW_NAME, canvas)

            code = cv2.waitKeyEx(5 if playing else 16)

            if playing and seeking:
                if time.monotonic() - last_seek_time >= SEEK_DEBOUNCE_SECONDS:
                    start_play()
            elif playing:
                elapsed = time.monotonic() - play_wall_start
                target = scrubber.clamp(play_frame_start + int(elapsed * scrubber.fps))
                while scrubber.index < target and scrubber.advance():
                    pass
                if elapsed >= PLAY_CHUNK_SECONDS or scrubber.index >= scrubber.frame_count - 1:
                    stop_play()
                    status = "playback ended"
                cv2.setTrackbarPos(TRACKBAR_NAME, WINDOW_NAME, scrubber.index)

            if code == -1:
                continue

            if code in ARROW_LEFT:
                scrubber.step(-1)
                if playing:
                    begin_seek()
            elif code in ARROW_RIGHT:
                scrubber.step(1)
                if playing:
                    begin_seek()
            elif code in ARROW_UP:
                scrubber.step(FAST_STEP_FRAMES)
                if playing:
                    begin_seek()
            elif code in ARROW_DOWN:
                scrubber.step(-FAST_STEP_FRAMES)
                if playing:
                    begin_seek()
            else:
                key = code & 0xFF
                if key == ord("i"):
                    scrubber.in_index = scrubber.index
                    status = f"in {format_timecode(scrubber.seconds_at(scrubber.index))}"
                elif key == ord("o"):
                    scrubber.out_index = scrubber.index
                    status = f"out {format_timecode(scrubber.seconds_at(scrubber.index))}"
                elif key == ord("c"):
                    stop_play()
                    status = cut_segment(scrubber, output_dir)
                elif key == ord("x"):
                    scrubber.in_index = None
                    scrubber.out_index = None
                    status = "marks cleared"
                elif key == ord(" "):
                    if playing:
                        stop_play()
                        status = "paused"
                    else:
                        status = start_play()
                elif key in (ord("q"), 27):
                    stop_play()
                    return 0
                else:
                    LOGGER.debug("unmapped keycode %s", code)

            cv2.setTrackbarPos(TRACKBAR_NAME, WINDOW_NAME, scrubber.index)
    finally:
        stop_play()
        scrubber.release()
        cv2.destroyAllWindows()


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Scrub a video frame by frame and cut precise clips.")
    parser.add_argument("video", nargs="?", default="", help="source video file; omit to pick from data/videos")
    parser.add_argument("--output-dir", type=Path, default=VIDEO_CLIP_ROOT, help="directory for clip outputs")
    arguments = parser.parse_args()

    if arguments.video:
        video_path = Path(arguments.video)
        if not video_path.exists():
            print(f"video not found: {video_path}", file=sys.stderr)
            return 2
    else:
        videos = find_videos()
        if not videos:
            print(f"no videos found in {VIDEO_DATA_ROOT}", file=sys.stderr)
            return 2
        chosen = choose_video(videos)
        if chosen is None:
            return 0
        video_path = chosen

    return run_clip_picker(video_path, arguments.output_dir)


if __name__ == "__main__":
    sys.exit(main())
