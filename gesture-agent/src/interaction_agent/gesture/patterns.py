import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Final, Protocol

from interaction_agent.paths import GESTURE_PATTERN_ROOT

LOGGER = logging.getLogger("gesture_agent.pattern_matching")

FeaturePoint = tuple[float, float]
PatternFrame = tuple[FeaturePoint, ...]


class Landmark(Protocol):
    x: float
    y: float


PATTERN_ROOT: Final = GESTURE_PATTERN_ROOT
ACTIVE_PATTERN_NAME: Final = "left_swipe"
PATTERN_LANDMARK_INDICES: Final = (0, 4, 5, 8, 9, 12, 13, 16, 17, 20)
MIN_RECORDING_FRAMES: Final = 8
LEFT_SWIPE_MIN_TIP_DX: Final = 0.2
LEFT_SWIPE_MIN_TIP_DY: Final = 0.12


@dataclass
class PatternExample:
    name: str
    created_at: str
    frames: list[PatternFrame]
    path: Path | None = None

    @property
    def frame_count(self) -> int:
        return len(self.frames)

    def to_json_payload(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "createdAt": self.created_at,
            "frameCount": self.frame_count,
            "landmarkIndices": list(PATTERN_LANDMARK_INDICES),
            "frames": [
                [[point[0], point[1]] for point in frame]
                for frame in self.frames
            ],
        }

    @classmethod
    def from_json_payload(cls, payload: dict[str, Any], path: Path) -> "PatternExample":
        name = payload.get("name")
        created_at = payload.get("createdAt")
        frames_payload = payload.get("frames")

        if not isinstance(name, str):
            raise ValueError("pattern payload missing string name")
        if not isinstance(created_at, str):
            raise ValueError("pattern payload missing string createdAt")
        if not isinstance(frames_payload, list):
            raise ValueError("pattern payload missing frames list")

        frames: list[PatternFrame] = []
        for frame_payload in frames_payload:
            if not isinstance(frame_payload, list):
                raise ValueError("pattern frame is not a list")

            points: list[FeaturePoint] = []
            for point_payload in frame_payload:
                if not isinstance(point_payload, list) or len(point_payload) != 2:
                    raise ValueError("pattern point is not an x/y pair")

                point_x, point_y = point_payload
                if not isinstance(point_x, int | float):
                    raise ValueError("pattern point x is not numeric")
                if not isinstance(point_y, int | float):
                    raise ValueError("pattern point y is not numeric")

                points.append((float(point_x), float(point_y)))

            if len(points) != len(PATTERN_LANDMARK_INDICES):
                raise ValueError("pattern frame has unexpected landmark count")

            frames.append(tuple(points))

        return cls(name=name, created_at=created_at, frames=frames, path=path)


@dataclass
class PatternLibrary:
    name: str
    examples: list[PatternExample]

    @property
    def example_count(self) -> int:
        return len(self.examples)

    def add_example(self, example: PatternExample) -> None:
        self.examples.append(example)


def pattern_directory(name: str) -> Path:
    return PATTERN_ROOT / name


def raw_pattern_frame(landmarks: Sequence[Landmark]) -> PatternFrame:
    return tuple((landmark.x, landmark.y) for landmark in landmarks)


def pattern_palm_center(frame: PatternFrame) -> FeaturePoint:
    palm_points = [0, 5, 9, 13, 17]
    x = sum(frame[index][0] for index in palm_points) / len(palm_points)
    y = sum(frame[index][1] for index in palm_points) / len(palm_points)
    return x, y


def pattern_hand_scale(frame: PatternFrame) -> float:
    xs = [point[0] for point in frame]
    ys = [point[1] for point in frame]
    return max(max(xs) - min(xs), max(ys) - min(ys), 0.001)


def normalize_pattern_frames(raw_frames: Sequence[PatternFrame]) -> list[PatternFrame]:
    if not raw_frames:
        return []

    anchor_x, anchor_y = pattern_palm_center(raw_frames[0])
    scale = pattern_hand_scale(raw_frames[0])
    normalized_frames: list[PatternFrame] = []

    for raw_frame in raw_frames:
        normalized_points = tuple(
            (
                (raw_frame[index][0] - anchor_x) / scale,
                (raw_frame[index][1] - anchor_y) / scale,
            )
            for index in PATTERN_LANDMARK_INDICES
        )
        normalized_frames.append(normalized_points)

    return normalized_frames


def save_pattern_example(example: PatternExample) -> Path:
    directory = pattern_directory(example.name)
    directory.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = directory / f"{timestamp}.json"
    path.write_text(json.dumps(example.to_json_payload(), indent=2), encoding="utf-8")
    example.path = path
    return path


def load_pattern_examples(name: str) -> list[PatternExample]:
    directory = pattern_directory(name)
    if not directory.exists():
        return []

    examples: list[PatternExample] = []
    for path in sorted(directory.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("pattern payload is not an object")

            example = PatternExample.from_json_payload(payload, path)
            if not is_usable_pattern_example(example):
                LOGGER.warning("skipping low-quality pattern file path=%s", path)
                continue

            examples.append(example)
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
            LOGGER.warning("skipping pattern file path=%s error=%s", path, exc)

    return examples


def is_usable_pattern_example(example: PatternExample) -> bool:
    if example.name != ACTIVE_PATTERN_NAME:
        return True

    if len(example.frames) < MIN_RECORDING_FRAMES:
        return False

    tip_dx, tip_dy = fingertip_delta(example.frames[0], example.frames[-1])
    return tip_dx <= -LEFT_SWIPE_MIN_TIP_DX and tip_dy >= LEFT_SWIPE_MIN_TIP_DY


def fingertip_delta(first_frame: PatternFrame, second_frame: PatternFrame) -> FeaturePoint:
    tip_indices = [1, 3, 5, 7, 9]
    dx = sum(second_frame[index][0] - first_frame[index][0] for index in tip_indices)
    dy = sum(second_frame[index][1] - first_frame[index][1] for index in tip_indices)
    return dx / len(tip_indices), dy / len(tip_indices)
