import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from math import hypot
from pathlib import Path
from typing import Any, Final

from interaction_agent.paths import GESTURE_RECORDING_ROOT
from interaction_agent.gesture.patterns import ACTIVE_PATTERN_NAME
from interaction_agent.gesture.patterns import FeaturePoint
from interaction_agent.gesture.patterns import PATTERN_LANDMARK_INDICES
from interaction_agent.gesture.patterns import PatternExample
from interaction_agent.gesture.patterns import PatternFrame
from interaction_agent.gesture.patterns import normalize_pattern_frames
from interaction_agent.gesture.patterns import save_pattern_example


LOGGER = logging.getLogger("gesture_agent.recording_analysis")

RECORDING_ROOT: Final = GESTURE_RECORDING_ROOT
MIN_SESSION_HAND_FRAMES: Final = 8
MOTION_STEP_THRESHOLD: Final = 0.025
PROMOTE_MIN_FRAMES: Final = 4
PROMOTE_MIN_LEFT_DX: Final = 0.2
PROMOTE_MIN_DOWN_DY: Final = 0.12

MotionLabel = str


@dataclass(frozen=True)
class SessionFrame:
    elapsed_seconds: float
    hand: PatternFrame | None


@dataclass
class SessionRecording:
    created_at: str
    frames: list[SessionFrame]
    path: Path | None = None

    @property
    def frame_count(self) -> int:
        return len(self.frames)

    @property
    def hand_frame_count(self) -> int:
        return sum(1 for frame in self.frames if frame.hand is not None)

    @property
    def missing_hand_count(self) -> int:
        return self.frame_count - self.hand_frame_count

    def hand_frames(self) -> list[PatternFrame]:
        return [frame.hand for frame in self.frames if frame.hand is not None]

    def to_json_payload(self) -> dict[str, Any]:
        return {
            "createdAt": self.created_at,
            "frameCount": self.frame_count,
            "handFrameCount": self.hand_frame_count,
            "missingHandCount": self.missing_hand_count,
            "frames": [
                {
                    "elapsedSeconds": frame.elapsed_seconds,
                    "hand": None
                    if frame.hand is None
                    else [[point[0], point[1]] for point in frame.hand],
                }
                for frame in self.frames
            ],
        }


@dataclass(frozen=True)
class ChunkSignals:
    duration_seconds: float
    fps: float
    tip_vx: float
    tip_vy: float
    tip_speed: float
    peak_step_speed: float
    direction_consistency: float
    start_aspect: float
    end_aspect: float
    mean_aspect: float
    start_thumb_side: float
    end_thumb_side: float
    mean_thumb_side: float
    start_index_pinky_dx: float
    end_index_pinky_dx: float
    mean_index_pinky_dx: float


@dataclass(frozen=True)
class MotionChunk:
    label: MotionLabel
    start_frame: int
    end_frame: int
    frame_count: int
    tip_dx: float
    tip_dy: float
    score: float
    raw_frames: list[PatternFrame]
    signals: ChunkSignals

    def short_summary(self) -> str:
        return (
            f"{self.label} {self.frame_count}f "
            f"dx={self.tip_dx:.2f} dy={self.tip_dy:.2f} "
            f"v={self.signals.tip_speed:.2f} "
            f"shape={self.signals.mean_aspect:.2f} "
            f"thumb={self.signals.mean_thumb_side:.2f}"
        )


@dataclass(frozen=True)
class SessionAnalysis:
    recording: SessionRecording
    chunks: list[MotionChunk]
    promoted_example: PatternExample | None

    def status_message(self) -> str:
        promoted = "none"
        if self.promoted_example is not None:
            promoted = f"{self.promoted_example.name}:{self.promoted_example.frame_count}f"

        return (
            f"SESSION {self.recording.hand_frame_count} hand frames "
            f"chunks={len(self.chunks)} promoted={promoted}"
        )

    def detail_lines(self) -> list[str]:
        if not self.chunks:
            return ["no motion chunks"]

        return [chunk.short_summary() for chunk in self.chunks]


@dataclass
class SessionRecorder:
    frames: list[SessionFrame] = field(default_factory=list)
    started_at: float | None = None
    last_analysis: SessionAnalysis | None = None

    @property
    def is_recording(self) -> bool:
        return self.started_at is not None

    @property
    def hand_frame_count(self) -> int:
        return sum(1 for frame in self.frames if frame.hand is not None)

    @property
    def missing_hand_count(self) -> int:
        return sum(1 for frame in self.frames if frame.hand is None)

    def start(self, now: float) -> None:
        self.frames.clear()
        self.started_at = now
        self.last_analysis = None
        LOGGER.info("session recording started")

    def add_hand_frame(self, raw_frame: PatternFrame, now: float) -> None:
        if self.started_at is None:
            return

        self.frames.append(
            SessionFrame(
                elapsed_seconds=now - self.started_at,
                hand=raw_frame,
            )
        )

    def add_missing_hand_frame(self, now: float) -> None:
        if self.started_at is None:
            return

        self.frames.append(
            SessionFrame(
                elapsed_seconds=now - self.started_at,
                hand=None,
            )
        )

    def stop(self) -> SessionAnalysis | None:
        if self.started_at is None:
            return None

        self.started_at = None
        recording = SessionRecording(
            created_at=datetime.now().isoformat(timespec="seconds"),
            frames=list(self.frames),
        )
        self.frames.clear()

        if recording.hand_frame_count < MIN_SESSION_HAND_FRAMES:
            LOGGER.info(
                "session recording discarded hand_frames=%s min=%s",
                recording.hand_frame_count,
                MIN_SESSION_HAND_FRAMES,
            )
            return None

        recording.path = save_session_recording(recording)
        self.last_analysis = analyze_session(recording)
        log_session_analysis(self.last_analysis)
        return self.last_analysis

    def status_message(self, example_count: int) -> str:
        if self.is_recording:
            return (
                f"SESSION REC ON hand={self.hand_frame_count} "
                f"miss={self.missing_hand_count} examples={example_count}"
            )

        if self.last_analysis is not None:
            return self.last_analysis.status_message()

        return f"SESSION REC OFF examples={example_count} key=r start/stop"


def save_session_recording(recording: SessionRecording) -> Path:
    RECORDING_ROOT.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = RECORDING_ROOT / f"session-{timestamp}.json"
    path.write_text(json.dumps(recording.to_json_payload(), indent=2), encoding="utf-8")
    return path


def analyze_session(recording: SessionRecording) -> SessionAnalysis:
    hand_frames = [
        frame
        for frame in recording.frames
        if frame.hand is not None
    ]
    chunks = segment_motion_with_times(
        raw_frames=[frame.hand for frame in hand_frames if frame.hand is not None],
        elapsed_seconds=[frame.elapsed_seconds for frame in hand_frames],
    )
    promoted_example = promote_best_left_down_chunk(chunks)
    return SessionAnalysis(
        recording=recording,
        chunks=chunks,
        promoted_example=promoted_example,
    )


def log_session_analysis(analysis: SessionAnalysis) -> None:
    LOGGER.info(
        "session analyzed path=%s hand_frames=%s chunks=%s promoted=%s",
        analysis.recording.path,
        analysis.recording.hand_frame_count,
        len(analysis.chunks),
        analysis.promoted_example.path if analysis.promoted_example else None,
    )
    for index, chunk in enumerate(analysis.chunks, start=1):
        LOGGER.info("chunk %s: %s", index, chunk.short_summary())


def segment_motion(raw_frames: list[PatternFrame]) -> list[MotionChunk]:
    return segment_motion_with_times(
        raw_frames=raw_frames,
        elapsed_seconds=[float(index) for index in range(len(raw_frames))],
    )


def segment_motion_with_times(
    raw_frames: list[PatternFrame],
    elapsed_seconds: list[float],
) -> list[MotionChunk]:
    if len(raw_frames) < 2:
        return []
    if len(raw_frames) != len(elapsed_seconds):
        raise ValueError("raw frame and elapsed time counts differ")

    normalized_frames = normalize_pattern_frames(raw_frames)
    labels = [
        classify_step_motion(previous_frame, current_frame)
        for previous_frame, current_frame in zip(
            normalized_frames,
            normalized_frames[1:],
        )
    ]

    chunks: list[MotionChunk] = []
    start_step = 0
    current_label = labels[0]
    for step_index, label in enumerate(labels[1:], start=1):
        if label == current_label:
            continue

        chunks.append(
            build_motion_chunk(
                current_label,
                start_step,
                step_index,
                raw_frames,
                normalized_frames,
                elapsed_seconds,
            )
        )
        current_label = label
        start_step = step_index

    chunks.append(
        build_motion_chunk(
            current_label,
            start_step,
            len(labels),
            raw_frames,
            normalized_frames,
            elapsed_seconds,
        )
    )
    return merge_short_static_chunks(chunks)


def classify_step_motion(previous_frame: PatternFrame, current_frame: PatternFrame) -> MotionLabel:
    dx, dy = fingertip_delta(previous_frame, current_frame)
    magnitude = (dx * dx + dy * dy) ** 0.5
    if magnitude < MOTION_STEP_THRESHOLD:
        return "static"

    if dx < 0 and dy > 0:
        return "left-down"
    if dx < 0 and dy <= 0:
        return "left-up"
    if dx >= 0 and dy < 0:
        return "right-up"
    return "right-down"


def build_motion_chunk(
    label: MotionLabel,
    start_step: int,
    end_step: int,
    raw_frames: list[PatternFrame],
    normalized_frames: list[PatternFrame],
    elapsed_seconds: list[float],
) -> MotionChunk:
    start_frame = start_step
    end_frame = end_step
    chunk_raw_frames = raw_frames[start_frame : end_frame + 1]
    tip_dx, tip_dy = fingertip_delta(
        normalized_frames[start_frame],
        normalized_frames[end_frame],
    )
    score = (tip_dx * tip_dx + tip_dy * tip_dy) ** 0.5
    signals = build_chunk_signals(
        raw_frames=raw_frames[start_frame : end_frame + 1],
        normalized_frames=normalized_frames[start_frame : end_frame + 1],
        elapsed_seconds=elapsed_seconds[start_frame : end_frame + 1],
        tip_dx=tip_dx,
        tip_dy=tip_dy,
    )
    return MotionChunk(
        label=label,
        start_frame=start_frame,
        end_frame=end_frame,
        frame_count=len(chunk_raw_frames),
        tip_dx=tip_dx,
        tip_dy=tip_dy,
        score=score,
        raw_frames=chunk_raw_frames,
        signals=signals,
    )


def merge_short_static_chunks(chunks: list[MotionChunk]) -> list[MotionChunk]:
    return [
        chunk
        for chunk in chunks
        if chunk.label != "static" or chunk.frame_count >= PROMOTE_MIN_FRAMES
    ]


def fingertip_delta(first_frame: PatternFrame, second_frame: PatternFrame) -> FeaturePoint:
    tip_indices = [1, 3, 5, 7, 9]
    dx = sum(second_frame[index][0] - first_frame[index][0] for index in tip_indices)
    dy = sum(second_frame[index][1] - first_frame[index][1] for index in tip_indices)
    return dx / len(tip_indices), dy / len(tip_indices)


def build_chunk_signals(
    raw_frames: list[PatternFrame],
    normalized_frames: list[PatternFrame],
    elapsed_seconds: list[float],
    tip_dx: float,
    tip_dy: float,
) -> ChunkSignals:
    duration_seconds = max(elapsed_seconds[-1] - elapsed_seconds[0], 0.001)
    frame_count = len(normalized_frames)
    fps = (frame_count - 1) / duration_seconds if frame_count > 1 else 0.0
    tip_vx = tip_dx / duration_seconds
    tip_vy = tip_dy / duration_seconds
    step_vectors = [
        fingertip_delta(previous_frame, current_frame)
        for previous_frame, current_frame in zip(
            normalized_frames,
            normalized_frames[1:],
        )
    ]
    step_speeds = [
        hypot(dx, dy) / max(next_time - previous_time, 0.001)
        for (dx, dy), previous_time, next_time in zip(
            step_vectors,
            elapsed_seconds,
            elapsed_seconds[1:],
        )
    ]
    peak_step_speed = max(step_speeds, default=0.0)
    direction_consistency = chunk_direction_consistency(step_vectors, tip_dx, tip_dy)
    aspect_values = [hand_aspect(frame) for frame in raw_frames]
    thumb_side_values = [thumb_side_signal(frame) for frame in normalized_frames]
    index_pinky_values = [
        frame[PATTERN_LANDMARK_INDICES.index(5)][0] - frame[PATTERN_LANDMARK_INDICES.index(17)][0]
        for frame in normalized_frames
    ]

    return ChunkSignals(
        duration_seconds=duration_seconds,
        fps=fps,
        tip_vx=tip_vx,
        tip_vy=tip_vy,
        tip_speed=hypot(tip_vx, tip_vy),
        peak_step_speed=peak_step_speed,
        direction_consistency=direction_consistency,
        start_aspect=aspect_values[0],
        end_aspect=aspect_values[-1],
        mean_aspect=sum(aspect_values) / len(aspect_values),
        start_thumb_side=thumb_side_values[0],
        end_thumb_side=thumb_side_values[-1],
        mean_thumb_side=sum(thumb_side_values) / len(thumb_side_values),
        start_index_pinky_dx=index_pinky_values[0],
        end_index_pinky_dx=index_pinky_values[-1],
        mean_index_pinky_dx=sum(index_pinky_values) / len(index_pinky_values),
    )


def chunk_direction_consistency(
    step_vectors: list[FeaturePoint],
    tip_dx: float,
    tip_dy: float,
) -> float:
    target_length = hypot(tip_dx, tip_dy)
    if target_length <= 0.001:
        return 0.0

    target_x = tip_dx / target_length
    target_y = tip_dy / target_length
    aligned_steps = 0
    moving_steps = 0
    for step_dx, step_dy in step_vectors:
        step_length = hypot(step_dx, step_dy)
        if step_length <= MOTION_STEP_THRESHOLD:
            continue

        moving_steps += 1
        dot = (step_dx / step_length) * target_x + (step_dy / step_length) * target_y
        if dot >= 0.5:
            aligned_steps += 1

    if moving_steps == 0:
        return 0.0

    return aligned_steps / moving_steps


def hand_aspect(frame: PatternFrame) -> float:
    xs = [point[0] for point in frame]
    ys = [point[1] for point in frame]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    return width / max(height, 0.001)


def thumb_side_signal(frame: PatternFrame) -> float:
    wrist = frame[PATTERN_LANDMARK_INDICES.index(0)]
    thumb_tip = frame[PATTERN_LANDMARK_INDICES.index(4)]
    xs = [point[0] for point in frame]
    ys = [point[1] for point in frame]
    hand_scale = max(max(xs) - min(xs), max(ys) - min(ys), 0.001)
    return (thumb_tip[0] - wrist[0]) / hand_scale


def promote_best_left_down_chunk(chunks: list[MotionChunk]) -> PatternExample | None:
    candidates = [
        chunk
        for chunk in chunks
        if chunk.label == "left-down"
        and chunk.frame_count >= PROMOTE_MIN_FRAMES
        and chunk.tip_dx <= -PROMOTE_MIN_LEFT_DX
        and chunk.tip_dy >= PROMOTE_MIN_DOWN_DY
    ]
    if not candidates:
        return None

    best_chunk = max(candidates, key=lambda chunk: chunk.score)
    example = PatternExample(
        name=ACTIVE_PATTERN_NAME,
        created_at=datetime.now().isoformat(timespec="seconds"),
        frames=normalize_pattern_frames(best_chunk.raw_frames),
    )
    save_pattern_example(example)
    return example
