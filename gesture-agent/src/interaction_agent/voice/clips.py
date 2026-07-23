"""Extract a timestamped segment from a source video as an mp4 plus a 16kHz
mono WAV.

The WAV plugs directly into pronunciation scoring (interaction_agent.voice.
pronunciation), so a clip cut from a reference video becomes a reference
utterance. Cutting is done with ffmpeg and re-encodes the segment so the
start/end timestamps are frame-accurate rather than snapped to keyframes.
"""

import argparse
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from interaction_agent.paths import VIDEO_CLIP_ROOT


CLIP_SAMPLE_RATE: Final = 16000
CLIP_CHANNELS: Final = 1
SLUG_MAX_LENGTH: Final = 60


@dataclass(frozen=True)
class ClipResult:
    mp4_path: Path
    wav_path: Path
    start_seconds: float
    end_seconds: float

    @property
    def duration_seconds(self) -> float:
        return self.end_seconds - self.start_seconds


def parse_timestamp(value: str) -> float:
    text = value.strip()
    if not text:
        raise ValueError("empty timestamp")

    parts = text.split(":")
    if len(parts) > 3:
        raise ValueError(f"invalid timestamp {value!r}: expected hh:mm:ss, mm:ss, or ss")

    try:
        numbers = [float(part) for part in parts]
    except ValueError as error:
        raise ValueError(f"invalid timestamp {value!r}: non-numeric component") from error

    if any(number < 0 for number in numbers):
        raise ValueError(f"invalid timestamp {value!r}: negative component")

    seconds = 0.0
    for number in numbers:
        seconds = seconds * 60.0 + number
    return seconds


def clock_label(seconds: float) -> str:
    total = int(round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}{minutes:02d}{secs:02d}"


def slugify(text: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return slug[:SLUG_MAX_LENGTH] or "clip"


def clip_stem(video_path: Path, start_seconds: float, end_seconds: float) -> str:
    return f"{slugify(video_path.stem)}-{clock_label(start_seconds)}-{clock_label(end_seconds)}"


def ensure_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f"{name} not found on PATH; install it (e.g. brew install ffmpeg)")


def run_ffmpeg(arguments: list[str]) -> None:
    completed = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {completed.stderr.strip()}")


def probe_duration(path: Path) -> float:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {completed.stderr.strip()}")
    return float(completed.stdout.strip())


def extract_clip(
    video_path: Path,
    start_seconds: float,
    end_seconds: float,
    output_dir: Path = VIDEO_CLIP_ROOT,
) -> ClipResult:
    if not video_path.exists():
        raise FileNotFoundError(f"video not found: {video_path}")
    if end_seconds <= start_seconds:
        raise ValueError(f"end ({end_seconds}s) must be after start ({start_seconds}s)")

    ensure_tool("ffmpeg")
    ensure_tool("ffprobe")
    output_dir.mkdir(parents=True, exist_ok=True)

    duration = end_seconds - start_seconds
    stem = clip_stem(video_path, start_seconds, end_seconds)
    mp4_path = output_dir / f"{stem}.mp4"
    wav_path = output_dir / f"{stem}.wav"

    seek = ["-ss", f"{start_seconds}", "-i", str(video_path), "-t", f"{duration}"]
    run_ffmpeg([*seek, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", str(mp4_path)])
    run_ffmpeg(
        [
            *seek,
            "-vn",
            "-ac",
            str(CLIP_CHANNELS),
            "-ar",
            str(CLIP_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ]
    )
    return ClipResult(
        mp4_path=mp4_path,
        wav_path=wav_path,
        start_seconds=start_seconds,
        end_seconds=end_seconds,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract a start..end segment of a video as an mp4 plus a 16kHz mono WAV.",
    )
    parser.add_argument("video", type=Path, help="source video file")
    parser.add_argument("start", type=parse_timestamp, help="start timestamp (hh:mm:ss, mm:ss, or ss)")
    parser.add_argument("end", type=parse_timestamp, help="end timestamp (hh:mm:ss, mm:ss, or ss)")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=VIDEO_CLIP_ROOT,
        help="directory for the clip outputs",
    )
    arguments = parser.parse_args()

    result = extract_clip(arguments.video, arguments.start, arguments.end, arguments.output_dir)
    print(f"requested:  {result.duration_seconds:.3f}s")
    print(f"mp4:        {result.mp4_path}  ({probe_duration(result.mp4_path):.3f}s)")
    print(f"wav:        {result.wav_path}  ({probe_duration(result.wav_path):.3f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
