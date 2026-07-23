import logging
import time
from collections.abc import Sequence
from datetime import datetime
from typing import Any, Final

from interaction_agent.gesture.cache import configure_cache

configure_cache()

import cv2
import mediapipe as mp

from interaction_agent.gesture.action.tracker import (
    ANCHOR_NEAR_HORIZONTAL_RADIUS,
    ANCHOR_NEAR_VERTICAL_RADIUS,
)
from interaction_agent.gesture.pose import (
    Landmark,
    PoseLabel,
    classify_landmarks_pose,
    measure_hand_pose,
)
from interaction_agent.gesture.patterns import PatternFrame
from interaction_agent.gesture.recording.analysis import SessionAnalysis
from interaction_agent.gesture.state import ButtonRect, RuntimeState
from interaction_agent.paths import GESTURE_SCREENSHOT_ROOT


LOGGER = logging.getLogger("gesture_agent.overlay")

SCREENSHOT_DIR: Final = GESTURE_SCREENSHOT_ROOT
RESET_BUTTON_WIDTH: Final = 190
RESET_BUTTON_HEIGHT: Final = 42
RESET_BUTTON_MARGIN: Final = 18
ANCHOR_BUTTON_WIDTH: Final = 190
ANCHOR_BUTTON_HEIGHT: Final = 42
ANCHOR_BUTTON_GAP: Final = 10
OVERLAY_PANEL_LEFT: Final = 12
OVERLAY_PANEL_TOP: Final = 14
OVERLAY_PANEL_WIDTH: Final = 690
OVERLAY_PANEL_HEIGHT: Final = 258
OVERLAY_PANEL_ALPHA: Final = 0.72


def draw_hand_landmarks(frame: Any, landmarks: Sequence[Landmark]) -> None:
    height, width = frame.shape[:2]

    for connection in mp.tasks.vision.HandLandmarksConnections.HAND_CONNECTIONS:
        start = landmarks[connection.start]
        end = landmarks[connection.end]
        start_point = (int(start.x * width), int(start.y * height))
        end_point = (int(end.x * width), int(end.y * height))
        cv2.line(frame, start_point, end_point, (0, 255, 0), 2)

    for landmark in landmarks:
        center = (int(landmark.x * width), int(landmark.y * height))
        cv2.circle(frame, center, 3, (0, 0, 255), -1)


def draw_face_landmarks(frame: Any, landmarks: Sequence[Landmark]) -> None:
    height, width = frame.shape[:2]

    for connection in mp.tasks.vision.FaceLandmarksConnections.FACE_LANDMARKS_CONTOURS:
        start = landmarks[connection.start]
        end = landmarks[connection.end]
        start_point = (int(start.x * width), int(start.y * height))
        end_point = (int(end.x * width), int(end.y * height))
        cv2.line(frame, start_point, end_point, (255, 180, 0), 1)

    for index in (1, 33, 61, 199, 263, 291):
        landmark = landmarks[index]
        center = (int(landmark.x * width), int(landmark.y * height))
        cv2.circle(frame, center, 2, (255, 255, 0), -1)


def draw_status(frame: Any, message: str, is_detection: bool) -> None:
    color = (0, 255, 255) if is_detection else (0, 255, 0)
    cv2.putText(
        frame,
        message,
        (20, 40),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.9,
        (0, 0, 0),
        5,
    )
    cv2.putText(
        frame,
        message,
        (20, 40),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.9,
        color,
        2,
    )


def draw_overlay_panel(frame: Any) -> None:
    frame_width = frame.shape[1]
    right = min(
        OVERLAY_PANEL_LEFT + OVERLAY_PANEL_WIDTH,
        frame_width - RESET_BUTTON_MARGIN,
    )
    bottom = OVERLAY_PANEL_TOP + OVERLAY_PANEL_HEIGHT

    overlay = frame.copy()
    cv2.rectangle(
        overlay,
        (OVERLAY_PANEL_LEFT, OVERLAY_PANEL_TOP),
        (right, bottom),
        (12, 16, 20),
        -1,
    )
    cv2.rectangle(
        overlay,
        (OVERLAY_PANEL_LEFT, OVERLAY_PANEL_TOP),
        (right, bottom),
        (45, 55, 64),
        1,
    )
    cv2.addWeighted(overlay, OVERLAY_PANEL_ALPHA, frame, 1 - OVERLAY_PANEL_ALPHA, 0, frame)


def draw_overlay_line(
    frame: Any,
    message: str,
    y: int,
    color: tuple[int, int, int],
) -> None:
    cv2.putText(
        frame,
        message,
        (20, y),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (0, 0, 0),
        4,
    )
    cv2.putText(
        frame,
        message,
        (20, y),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        color,
        1,
    )


def draw_trace(frame: Any, message: str) -> None:
    draw_overlay_line(frame, message, 108, (255, 255, 255))


def draw_count_status(frame: Any, message: str) -> None:
    draw_overlay_line(frame, message, 76, (0, 255, 255))


def draw_recording_status(frame: Any, message: str, is_recording: bool) -> None:
    color = (0, 80, 255) if is_recording else (200, 200, 200)
    draw_overlay_line(frame, message, 164, color)


def draw_session_details(frame: Any, analysis: SessionAnalysis | None) -> None:
    if analysis is None:
        return

    for index, line in enumerate(analysis.detail_lines()[:3]):
        y = 196 + index * 28
        draw_overlay_line(frame, f"C{index + 1}: {line}", y, (180, 220, 255))


def draw_reset_counter_button(state: RuntimeState, frame: Any) -> None:
    frame_width = frame.shape[1]
    left = frame_width - RESET_BUTTON_WIDTH - RESET_BUTTON_MARGIN
    top = RESET_BUTTON_MARGIN
    right = left + RESET_BUTTON_WIDTH
    bottom = top + RESET_BUTTON_HEIGHT
    state.reset_button_rect = (left, top, right, bottom)

    cv2.rectangle(frame, (left, top), (right, bottom), (16, 20, 24), -1)
    cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 255), 2)
    cv2.putText(
        frame,
        "Reset count",
        (left + 18, top + 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 255, 255),
        2,
    )


def draw_anchor_button(state: RuntimeState, frame: Any) -> None:
    frame_width = frame.shape[1]
    left = frame_width - ANCHOR_BUTTON_WIDTH - RESET_BUTTON_MARGIN
    top = RESET_BUTTON_MARGIN + RESET_BUTTON_HEIGHT + ANCHOR_BUTTON_GAP
    right = left + ANCHOR_BUTTON_WIDTH
    bottom = top + ANCHOR_BUTTON_HEIGHT
    state.anchor_button_rect = (left, top, right, bottom)

    cv2.rectangle(frame, (left, top), (right, bottom), (16, 20, 24), -1)
    cv2.rectangle(frame, (left, top), (right, bottom), (0, 220, 120), 2)
    cv2.putText(
        frame,
        "Set anchor",
        (left + 18, top + 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (0, 220, 120),
        2,
    )


def draw_anchor_marker(state: RuntimeState, frame: Any) -> None:
    action_tracker = state.action_tracker
    if action_tracker.anchor is None:
        return

    height, width = frame.shape[:2]
    center_x, center_y = action_tracker.anchor.center
    center = (int(center_x * width), int(center_y * height))
    radius_x = max(8, int(action_tracker.anchor.scale * ANCHOR_NEAR_HORIZONTAL_RADIUS * width))
    radius_y = max(8, int(action_tracker.anchor.scale * ANCHOR_NEAR_VERTICAL_RADIUS * height))
    is_near_anchor = (
        action_tracker.current_position is not None
        and action_tracker.current_position.region == "near"
    )
    color = (0, 255, 180) if is_near_anchor else (0, 220, 120)
    thickness = 3 if is_near_anchor else 2
    if is_near_anchor:
        glow = frame.copy()
        cv2.ellipse(glow, center, (radius_x + 8, radius_y + 8), 0, 0, 360, color, 8)
        cv2.addWeighted(glow, 0.35, frame, 0.65, 0, frame)

    cv2.ellipse(frame, center, (radius_x, radius_y), 0, 0, 360, color, thickness)
    cv2.circle(frame, center, 5, color, -1)
    cv2.line(frame, (center[0] - 14, center[1]), (center[0] + 14, center[1]), color, 1)
    cv2.line(frame, (center[0], center[1] - 14), (center[0], center[1] + 14), color, 1)
    cv2.putText(
        frame,
        "palm anchor",
        (center[0] + 10, center[1] - 10),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        color,
        2,
    )


def is_inside_rect(x: int, y: int, rect: ButtonRect) -> bool:
    left, top, right, bottom = rect
    return left <= x <= right and top <= y <= bottom


def on_mouse_event(
    state: RuntimeState,
    event: int,
    x: int,
    y: int,
    flags: int,
    param: Any,
) -> None:
    del flags, param

    if event != cv2.EVENT_LBUTTONDOWN:
        return

    if state.anchor_button_rect is not None and is_inside_rect(x, y, state.anchor_button_rect):
        state.set_anchor_requested = True
        return

    if state.reset_button_rect is None:
        return

    if is_inside_rect(x, y, state.reset_button_rect):
        state.reset_count_requested = True


def handle_reset_count_request(state: RuntimeState) -> None:
    if not state.reset_count_requested:
        return

    state.reset_count_requested = False
    state.action_tracker.reset_count()
    LOGGER.info("swipe counts reset")


def set_anchor_from_raw_frame(state: RuntimeState, raw_frame: PatternFrame | None) -> None:
    if raw_frame is None:
        LOGGER.info("anchor request ignored because no hand is visible")
        return

    state.action_tracker.set_anchor(raw_frame, time.monotonic())
    anchor = state.action_tracker.anchor
    if anchor is not None:
        LOGGER.info("anchor set center=%s scale=%.3f", anchor.center, anchor.scale)


def handle_set_anchor_request(state: RuntimeState, raw_frame: PatternFrame | None) -> None:
    if not state.set_anchor_requested:
        return

    state.set_anchor_requested = False
    set_anchor_from_raw_frame(state, raw_frame)


def pose_status_message(landmarks: Sequence[Landmark]) -> tuple[PoseLabel, str]:
    pose = measure_hand_pose(landmarks)
    pose_label = classify_landmarks_pose(landmarks, None)
    return pose_label, f"POSE: {pose_label}  w={pose.width:.3f} a={pose.aspect:.2f}"


def append_face_count(message: str, face_count: int) -> str:
    if face_count == 0:
        return f"{message}  FACE:0"

    return f"{message}  FACE:{face_count}"


def save_screenshot(frame: Any) -> None:
    SCREENSHOT_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = SCREENSHOT_DIR / f"gesture-{timestamp}.png"

    if not cv2.imwrite(str(path), frame):
        LOGGER.error("failed to save screenshot path=%s", path)
        return

    LOGGER.info("saved screenshot path=%s", path)
