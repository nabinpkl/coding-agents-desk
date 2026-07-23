import logging
import time
from typing import Final

from interaction_agent.gesture.cache import configure_cache

configure_cache()

import cv2
import mediapipe as mp

from interaction_agent.gesture.camera import camera_backend, open_camera
from interaction_agent.gesture.mediapipe_models import (
    FACE_MODEL_PATH,
    HAND_MODEL_PATH,
    create_face_landmarker,
    create_hand_landmarker,
    create_landmarkers,
)
from interaction_agent.gesture.overlay import (
    append_face_count,
    draw_anchor_button,
    draw_anchor_marker,
    draw_count_status,
    draw_face_landmarks,
    draw_hand_landmarks,
    draw_overlay_panel,
    draw_recording_status,
    draw_reset_counter_button,
    draw_session_details,
    draw_status,
    draw_trace,
    handle_reset_count_request,
    handle_set_anchor_request,
    on_mouse_event,
    pose_status_message,
    save_screenshot,
    set_anchor_from_raw_frame,
)
from interaction_agent.gesture.patterns import (
    ACTIVE_PATTERN_NAME,
    PatternFrame,
    PatternLibrary,
    load_pattern_examples,
    raw_pattern_frame,
)
from interaction_agent.gesture.state import (
    GestureAnchorSnapshot,
    GestureCountsSnapshot,
    GestureHandSnapshot,
    GestureStateSnapshot,
    RuntimeHooks,
    RuntimeState,
    build_gesture_state_snapshot,
)


LOGGER = logging.getLogger("gesture_agent")

WINDOW_NAME: Final = "Gesture Control"


def run_gesture_app(hooks: RuntimeHooks | None = None) -> int:
    hooks = hooks or RuntimeHooks()
    state = RuntimeState()

    try:
        hand_landmarker, face_landmarker = create_landmarkers()
    except FileNotFoundError as exc:
        LOGGER.error("%s", exc)
        if hooks.on_error is not None:
            hooks.on_error(str(exc))
        return 2

    cap = open_camera()
    if not cap.isOpened():
        if hooks.on_error is not None:
            hooks.on_error("camera unavailable")
        return 3

    state.pattern_library = PatternLibrary(
        name=ACTIVE_PATTERN_NAME,
        examples=load_pattern_examples(ACTIVE_PATTERN_NAME),
    )
    LOGGER.info(
        "loaded pattern examples name=%s count=%s",
        ACTIVE_PATTERN_NAME,
        state.pattern_library.example_count,
    )

    try:
        with hand_landmarker, face_landmarker:
            cv2.namedWindow(WINDOW_NAME)
            cv2.setMouseCallback(
                WINDOW_NAME,
                lambda event, x, y, flags, param: on_mouse_event(
                    state, event, x, y, flags, param
                ),
            )

            stream_started = False
            stream_start_time = time.monotonic()
            last_timestamp_ms = -1
            last_raw_frame: PatternFrame | None = None
            if hooks.on_ready is not None:
                hooks.on_ready()

            while cap.isOpened():
                ok, frame = cap.read()
                if not ok:
                    LOGGER.error("camera opened but no frame was returned")
                    if hooks.on_error is not None:
                        hooks.on_error("camera frame unavailable")
                    return 4

                if not stream_started:
                    LOGGER.info("camera stream started")
                    stream_started = True

                frame = cv2.flip(frame, 1)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                timestamp_ms = int((time.monotonic() - stream_start_time) * 1000)
                timestamp_ms = max(timestamp_ms, last_timestamp_ms + 1)
                last_timestamp_ms = timestamp_ms

                hand_result = hand_landmarker.detect_for_video(mp_image, timestamp_ms)
                face_result = face_landmarker.detect_for_video(mp_image, timestamp_ms)
                last_raw_frame = None

                action_headline, is_detection = state.action_tracker.headline(time.monotonic())
                status_message = action_headline
                action_detail = state.action_tracker.detail(time.monotonic())
                count_message = state.action_tracker.count_message()
                face_count = len(face_result.face_landmarks)

                for face_landmarks in face_result.face_landmarks:
                    draw_face_landmarks(frame, face_landmarks)

                if hand_result.hand_landmarks:
                    hand_landmarks = hand_result.hand_landmarks[0]
                    raw_frame = raw_pattern_frame(hand_landmarks)
                    last_raw_frame = raw_frame
                    pose_label, pose_message = pose_status_message(hand_landmarks)
                    del pose_label
                    now = time.monotonic()

                    if state.session_recorder.is_recording:
                        state.session_recorder.add_hand_frame(raw_frame, now)

                    action = state.action_tracker.update(raw_frame=raw_frame, now=now)
                    state.emit_status(hooks, state.action_tracker.phase.lower())
                    if action is not None and hooks.on_action is not None:
                        hooks.on_action(action)

                    action_headline, is_detection = state.action_tracker.headline(time.monotonic())
                    action_detail = state.action_tracker.detail(time.monotonic())
                    count_message = state.action_tracker.count_message()
                    if state.session_recorder.is_recording and not is_detection:
                        status_message = pose_message
                    else:
                        status_message = action_headline

                    draw_hand_landmarks(frame, hand_landmarks)
                else:
                    if state.session_recorder.is_recording:
                        state.session_recorder.add_missing_hand_frame(time.monotonic())
                    state.action_tracker.clear_motion()
                    state.emit_status(hooks, "noHand")
                    action_headline, is_detection = state.action_tracker.headline(time.monotonic())
                    action_detail = state.action_tracker.detail(time.monotonic())
                    count_message = state.action_tracker.count_message()
                    status_message = action_headline

                state.emit_gesture_state(hooks, last_raw_frame, time.monotonic())
                draw_anchor_marker(state, frame)
                status_message = append_face_count(status_message, face_count)
                draw_overlay_panel(frame)
                draw_status(frame, status_message, is_detection)
                draw_count_status(frame, count_message)
                draw_trace(frame, action_detail)
                draw_recording_status(
                    frame,
                    state.session_recorder.status_message(state.pattern_library.example_count),
                    state.session_recorder.is_recording,
                )
                draw_session_details(frame, state.session_recorder.last_analysis)

                draw_reset_counter_button(state, frame)
                draw_anchor_button(state, frame)
                cv2.imshow(WINDOW_NAME, frame)
                handle_reset_count_request(state)
                handle_set_anchor_request(state, last_raw_frame)

                key = cv2.waitKey(1) & 0xFF
                if key == ord(" "):
                    save_screenshot(frame)
                elif key == ord("a"):
                    set_anchor_from_raw_frame(state, last_raw_frame)
                elif key == ord("r"):
                    if state.session_recorder.is_recording:
                        analysis = state.session_recorder.stop()
                        if analysis is not None and analysis.promoted_example is not None:
                            state.pattern_library.add_example(analysis.promoted_example)
                    else:
                        state.session_recorder.start(time.monotonic())
                elif key == ord("q"):
                    LOGGER.info("quit requested")
                    return 0

    finally:
        cap.release()
        cv2.destroyAllWindows()
        LOGGER.info("camera released")

    return 0


__all__ = [
    "FACE_MODEL_PATH",
    "HAND_MODEL_PATH",
    "GestureAnchorSnapshot",
    "GestureCountsSnapshot",
    "GestureHandSnapshot",
    "GestureStateSnapshot",
    "RuntimeHooks",
    "RuntimeState",
    "build_gesture_state_snapshot",
    "camera_backend",
    "create_face_landmarker",
    "create_hand_landmarker",
    "create_landmarkers",
    "open_camera",
    "run_gesture_app",
]
