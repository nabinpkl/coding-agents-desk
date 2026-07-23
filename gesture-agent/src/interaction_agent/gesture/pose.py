from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal, Protocol


PoseLabel = Literal[
    "OPEN_PALM",
    "ROTATED_90",
    "PARALLEL_HANDS_DOWN",
    "NEAR_PARALLEL_HANDS_UP",
    "UNKNOWN",
]


class Landmark(Protocol):
    x: float
    y: float


OPEN_PALM_MIN_WIDTH: Final = 0.14
OPEN_PALM_MIN_ASPECT: Final = 0.45
PARALLEL_FINGER_MIN_LEFT_DX: Final = 0.04
PARALLEL_FINGER_MIN_DOWN_DY: Final = 0.015
PARALLEL_FINGER_MAX_SLOPE: Final = 2.4
PARALLEL_FINGER_MIN_COUNT: Final = 3
NEAR_PARALLEL_UP_MIN_RIGHT_DX: Final = 0.035
NEAR_PARALLEL_UP_MIN_UP_DY: Final = 0.025
NEAR_PARALLEL_UP_MAX_SLOPE: Final = 2.0
NEAR_PARALLEL_UP_MIN_COUNT: Final = 3
ROTATED_WIDTH_RATIO: Final = 0.58
ROTATED_MAX_ASPECT: Final = 0.38


@dataclass(frozen=True)
class HandPose:
    center: tuple[float, float]
    width: float
    height: float
    aspect: float


def palm_center(landmarks: Sequence[Landmark]) -> tuple[float, float]:
    palm_points = [0, 5, 9, 13, 17]

    x = sum(landmarks[i].x for i in palm_points) / len(palm_points)
    y = sum(landmarks[i].y for i in palm_points) / len(palm_points)

    return x, y


def measure_hand_pose(landmarks: Sequence[Landmark]) -> HandPose:
    center = palm_center(landmarks)
    xs = [landmark.x for landmark in landmarks]
    ys = [landmark.y for landmark in landmarks]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    aspect = width / max(height, 0.001)
    return HandPose(center=center, width=width, height=height, aspect=aspect)


def is_open_palm(pose: HandPose) -> bool:
    return pose.width >= OPEN_PALM_MIN_WIDTH and pose.aspect >= OPEN_PALM_MIN_ASPECT


def is_parallel_hands_down(landmarks: Sequence[Landmark]) -> bool:
    finger_pairs = [(5, 8), (9, 12), (13, 16), (17, 20)]
    parallel_count = 0

    for base_index, tip_index in finger_pairs:
        base = landmarks[base_index]
        tip = landmarks[tip_index]
        dx = tip.x - base.x
        dy = tip.y - base.y

        if dx > -PARALLEL_FINGER_MIN_LEFT_DX:
            continue

        if dy < PARALLEL_FINGER_MIN_DOWN_DY:
            continue

        if dy > abs(dx) * PARALLEL_FINGER_MAX_SLOPE:
            continue

        parallel_count += 1

    return parallel_count >= PARALLEL_FINGER_MIN_COUNT


def is_near_parallel_hands_up(landmarks: Sequence[Landmark]) -> bool:
    finger_pairs = [(5, 8), (9, 12), (13, 16), (17, 20)]
    near_parallel_count = 0

    for base_index, tip_index in finger_pairs:
        base = landmarks[base_index]
        tip = landmarks[tip_index]
        dx = tip.x - base.x
        dy = tip.y - base.y

        if dx < NEAR_PARALLEL_UP_MIN_RIGHT_DX:
            continue

        if dy > -NEAR_PARALLEL_UP_MIN_UP_DY:
            continue

        if abs(dy) > dx * NEAR_PARALLEL_UP_MAX_SLOPE:
            continue

        near_parallel_count += 1

    return near_parallel_count >= NEAR_PARALLEL_UP_MIN_COUNT


def is_rotated_90(pose: HandPose, open_anchor_width: float | None) -> bool:
    if open_anchor_width is not None and pose.width <= open_anchor_width * ROTATED_WIDTH_RATIO:
        return True

    return pose.aspect <= ROTATED_MAX_ASPECT


def classify_pose(pose: HandPose, open_anchor_width: float | None) -> PoseLabel:
    if is_rotated_90(pose, open_anchor_width):
        return "ROTATED_90"

    if is_open_palm(pose):
        return "OPEN_PALM"

    return "UNKNOWN"


def classify_landmarks_pose(
    landmarks: Sequence[Landmark],
    open_anchor_width: float | None,
) -> PoseLabel:
    if is_near_parallel_hands_up(landmarks):
        return "NEAR_PARALLEL_HANDS_UP"

    if is_parallel_hands_down(landmarks):
        return "PARALLEL_HANDS_DOWN"

    pose = measure_hand_pose(landmarks)
    return classify_pose(pose, open_anchor_width)
