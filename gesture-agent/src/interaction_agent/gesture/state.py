from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final

from interaction_agent.gesture.action.tracker import (
    ANCHOR_NEAR_HORIZONTAL_RADIUS,
    ANCHOR_NEAR_VERTICAL_RADIUS,
    ActionEvent,
    ActionTracker,
)
from interaction_agent.gesture.patterns import (
    PatternFrame,
    PatternLibrary,
    pattern_palm_center,
)
from interaction_agent.gesture.recording.analysis import SessionRecorder


ButtonRect = tuple[int, int, int, int]
ActionCallback = Callable[[ActionEvent], None]
StateCallback = Callable[["GestureStateSnapshot"], None]
StatusCallback = Callable[[str], None]
ErrorCallback = Callable[[str], None]
ReadyCallback = Callable[[], None]

STATE_EMIT_INTERVAL_SECONDS: Final = 1 / 15


@dataclass(frozen=True)
class GestureCountsSnapshot:
    left: int
    right: int


@dataclass(frozen=True)
class GestureAnchorSnapshot:
    center: tuple[float, float]
    radius: tuple[float, float]
    near: bool


@dataclass(frozen=True)
class GestureHandSnapshot:
    center: tuple[float, float]
    landmarks: list[tuple[float, float]]


@dataclass(frozen=True)
class GestureStateSnapshot:
    phase: str
    counts: GestureCountsSnapshot
    anchor: GestureAnchorSnapshot | None
    hand: GestureHandSnapshot | None
    created_at: float


@dataclass
class RuntimeHooks:
    on_ready: ReadyCallback | None = None
    on_status: StatusCallback | None = None
    on_error: ErrorCallback | None = None
    on_action: ActionCallback | None = None
    on_state: StateCallback | None = None


@dataclass
class RuntimeState:
    session_recorder: SessionRecorder = field(default_factory=SessionRecorder)
    action_tracker: ActionTracker = field(default_factory=ActionTracker)
    pattern_library: PatternLibrary | None = None
    reset_button_rect: ButtonRect | None = None
    anchor_button_rect: ButtonRect | None = None
    reset_count_requested: bool = False
    set_anchor_requested: bool = False
    last_status: str | None = None
    last_state_emit_at: float = 0.0

    def emit_status(self, hooks: RuntimeHooks, state: str) -> None:
        if state == self.last_status:
            return

        self.last_status = state
        if hooks.on_status is not None:
            hooks.on_status(state)

    def emit_gesture_state(
        self,
        hooks: RuntimeHooks,
        raw_frame: PatternFrame | None,
        now: float,
    ) -> None:
        if hooks.on_state is None:
            return

        if now - self.last_state_emit_at < STATE_EMIT_INTERVAL_SECONDS:
            return

        self.last_state_emit_at = now
        hooks.on_state(build_gesture_state_snapshot(self, raw_frame, now))


def build_gesture_state_snapshot(
    state: RuntimeState,
    raw_frame: PatternFrame | None,
    now: float,
) -> GestureStateSnapshot:
    action_tracker = state.action_tracker
    anchor_snapshot: GestureAnchorSnapshot | None = None
    if action_tracker.anchor is not None:
        anchor_snapshot = GestureAnchorSnapshot(
            center=action_tracker.anchor.center,
            radius=(
                action_tracker.anchor.scale * ANCHOR_NEAR_HORIZONTAL_RADIUS,
                action_tracker.anchor.scale * ANCHOR_NEAR_VERTICAL_RADIUS,
            ),
            near=(
                action_tracker.current_position is not None
                and action_tracker.current_position.region == "near"
            ),
        )

    hand_snapshot: GestureHandSnapshot | None = None
    if raw_frame is not None:
        hand_snapshot = GestureHandSnapshot(
            center=pattern_palm_center(raw_frame),
            landmarks=list(raw_frame),
        )

    return GestureStateSnapshot(
        phase=action_tracker.phase,
        counts=GestureCountsSnapshot(
            left=action_tracker.left_swipe_count,
            right=action_tracker.right_swipe_count,
        ),
        anchor=anchor_snapshot,
        hand=hand_snapshot,
        created_at=now,
    )
