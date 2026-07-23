from dataclasses import dataclass, field
from typing import Final, Literal

from interaction_agent.gesture.patterns import (
    PatternFrame,
    pattern_hand_scale,
    pattern_palm_center,
)


ActionLabel = Literal["LEFT SWIPE", "RIGHT SWIPE"]
AnchorPhase = Literal["NO_ANCHOR", "NO_HAND", "READY", "ARMED", "WAIT_RETURN"]
AnchorRegion = Literal["near", "left_trigger", "right_trigger", "away"]

ACTION_DISPLAY_SECONDS: Final = 1.0
ACTION_COOLDOWN_SECONDS: Final = 0.35
ANCHOR_NEAR_HORIZONTAL_RADIUS: Final = 0.22
ANCHOR_NEAR_VERTICAL_RADIUS: Final = 0.55
LEFT_TRIGGER_DX: Final = -0.55
LEFT_TRIGGER_MIN_DY: Final = 0.10
LEFT_LOCAL_MOTION_SECONDS: Final = 0.65
LEFT_LOCAL_TRIGGER_DX: Final = -0.20
LEFT_LOCAL_TRIGGER_DY: Final = 0.08
LEFT_LOCAL_TRIGGER_MAX_POSITION_DX: Final = -0.14
LEFT_LOCAL_TRIGGER_MIN_START_DX: Final = -0.05
LEFT_SHAPE_TRIGGER_DX: Final = -0.12
LEFT_SHAPE_TRIGGER_DY: Final = 0.03
LEFT_SHAPE_TRIGGER_MAX_POSITION_DX: Final = -0.12
LEFT_SHAPE_TRIGGER_MIN_START_DX: Final = -0.08
LEFT_SHAPE_MIN_WIDTH: Final = 0.17
LEFT_SHAPE_MIN_ASPECT: Final = 0.40
LEFT_SHAPE_MIN_INDEX_PINKY_DX: Final = 0.25
LEFT_FINGER_TIP_INDICES: Final = (8, 12, 16, 20)
LEFT_FINGER_MIN_INDEX_DX: Final = -0.22
LEFT_FINGER_MIN_MIDDLE_DX: Final = -0.40
LEFT_FINGER_MIN_RING_DX: Final = -0.45
LEFT_FINGER_MIN_PINKY_DX: Final = -0.30
LEFT_FINGER_MIN_INDEX_PINKY_DX: Final = 0.25
LEFT_FINGER_MAX_ABS_CENTER_DY: Final = 0.08
RIGHT_TRIGGER_DX: Final = 0.23
RIGHT_OPEN_TRIGGER_MIN_DX: Final = 0.12
RIGHT_OPEN_TRIGGER_MAX_ABS_DY: Final = 0.30
RIGHT_OPEN_TRIGGER_MIN_WIDTH: Final = 0.23
RIGHT_OPEN_TRIGGER_MIN_ASPECT: Final = 0.65
RIGHT_OPEN_TRIGGER_MAX_INDEX_PINKY_DX: Final = -0.25
RIGHT_FINGER_TIP_INDICES: Final = (8, 12, 16, 20)
RIGHT_FINGER_MIN_INDEX_DX: Final = 0.22
RIGHT_FINGER_MIN_MIDDLE_DX: Final = 0.33
RIGHT_FINGER_MIN_RING_DX: Final = 0.40
RIGHT_FINGER_MIN_PINKY_DX: Final = 0.38
RIGHT_FINGER_MAX_INDEX_PINKY_DX: Final = -0.28
RIGHT_FINGER_MAX_CENTER_DX: Final = 0.15
RIGHT_FINGER_MAX_ABS_CENTER_DY: Final = 0.08
ANCHOR_RETURN_MAX_WIDTH: Final = 0.20
ANCHOR_RETURN_MAX_ASPECT: Final = 0.50


@dataclass(frozen=True)
class AnchorSnapshot:
    center: tuple[float, float]
    scale: float
    width: float
    aspect: float
    enables_open_palm_right_trigger: bool
    created_at: float


@dataclass(frozen=True)
class RelativeHandPosition:
    dx: float
    dy: float
    region: AnchorRegion


@dataclass(frozen=True)
class MotionSample:
    created_at: float
    position: RelativeHandPosition


@dataclass(frozen=True)
class ActionEvent:
    label: ActionLabel
    position: RelativeHandPosition
    confidence: float
    created_at: float

    def debug_message(self) -> str:
        return (
            f"action={self.label} region={self.position.region} "
            f"dx={self.position.dx:.2f} dy={self.position.dy:.2f} "
            f"conf={self.confidence:.2f}"
        )


@dataclass
class ActionTracker:
    anchor: AnchorSnapshot | None = None
    phase: AnchorPhase = "NO_ANCHOR"
    current_position: RelativeHandPosition | None = None
    left_swipe_count: int = 0
    right_swipe_count: int = 0
    last_event: ActionEvent | None = None
    cooldown_until: float = 0.0
    hand_lost_phase: AnchorPhase | None = None
    return_requires_anchor_shape: bool = False
    motion_samples: list[MotionSample] = field(default_factory=list)

    def set_anchor(self, raw_frame: PatternFrame, now: float) -> None:
        width, aspect = hand_width_and_aspect(raw_frame)
        self.anchor = AnchorSnapshot(
            center=pattern_palm_center(raw_frame),
            scale=pattern_hand_scale(raw_frame),
            width=width,
            aspect=aspect,
            enables_open_palm_right_trigger=is_anchor_return_shape(raw_frame),
            created_at=now,
        )
        self.current_position = self.relative_position(raw_frame)
        self.phase = "READY"
        self.cooldown_until = 0.0
        self.hand_lost_phase = None
        self.return_requires_anchor_shape = False
        self.motion_samples = [
            MotionSample(created_at=now, position=self.current_position)
        ]

    def reset_count(self) -> None:
        self.left_swipe_count = 0
        self.right_swipe_count = 0
        self.last_event = None
        self.cooldown_until = 0.0
        self.hand_lost_phase = None
        self.return_requires_anchor_shape = False
        self.motion_samples.clear()
        if self.anchor is None:
            self.phase = "NO_ANCHOR"
        elif self.current_position is not None and self.current_position.region == "near":
            self.phase = "READY"

    def clear_motion(self) -> None:
        self.mark_no_hand()

    def mark_no_hand(self) -> None:
        if self.phase not in ("NO_ANCHOR", "NO_HAND"):
            self.hand_lost_phase = self.phase
        self.current_position = None
        self.phase = "NO_ANCHOR" if self.anchor is None else "NO_HAND"

    def update(self, raw_frame: PatternFrame, now: float) -> ActionEvent | None:
        if self.anchor is None:
            self.phase = "NO_ANCHOR"
            self.current_position = None
            self.motion_samples.clear()
            return None

        position = self.relative_position(raw_frame)
        self.current_position = position
        current_sample = self.remember_motion_sample(position, now)

        if self.phase == "NO_HAND":
            if position.region == "near":
                self.phase = "READY"
                self.hand_lost_phase = None
            elif self.hand_lost_phase in ("READY", "ARMED"):
                self.phase = "ARMED"
            else:
                self.phase = "WAIT_RETURN"

        if self.phase == "WAIT_RETURN":
            ready_to_return = (
                not self.return_requires_anchor_shape
                or is_anchor_return_shape(raw_frame)
            )
            if position.region == "near" and ready_to_return:
                self.phase = "READY"
                self.hand_lost_phase = None
                self.return_requires_anchor_shape = False
                self.motion_samples = [current_sample]
            return None

        if now < self.cooldown_until:
            return None

        local_left_confidence = self.local_left_confidence(raw_frame, position, now)
        if local_left_confidence is not None:
            return self.record_event(
                "LEFT SWIPE",
                position,
                now,
                confidence=local_left_confidence,
                return_requires_anchor_shape=True,
            )

        if self.should_record_fingertip_left(raw_frame, position):
            return self.record_event(
                "LEFT SWIPE",
                position,
                now,
                confidence=1.0,
                return_requires_anchor_shape=True,
            )

        if self.should_record_open_palm_right(raw_frame, position):
            return self.record_event(
                "RIGHT SWIPE",
                position,
                now,
                confidence=1.0,
                return_requires_anchor_shape=True,
            )

        if self.should_record_fingertip_right(raw_frame, position):
            return self.record_event(
                "RIGHT SWIPE",
                position,
                now,
                confidence=1.0,
                return_requires_anchor_shape=True,
            )

        if position.region == "near":
            self.phase = "READY"
            return None

        if self.phase == "READY":
            self.phase = "ARMED"

        if self.phase != "ARMED":
            return None

        if position.region == "left_trigger":
            return self.record_event("LEFT SWIPE", position, now)

        if position.region == "right_trigger":
            return self.record_event("RIGHT SWIPE", position, now)

        return None

    def remember_motion_sample(
        self,
        position: RelativeHandPosition,
        now: float,
    ) -> MotionSample:
        sample = MotionSample(created_at=now, position=position)
        self.motion_samples.append(sample)
        self.motion_samples = [
            motion_sample
            for motion_sample in self.motion_samples
            if now - motion_sample.created_at <= LEFT_LOCAL_MOTION_SECONDS
        ]
        return sample

    def local_left_confidence(
        self,
        raw_frame: PatternFrame,
        position: RelativeHandPosition,
        now: float,
    ) -> float | None:
        if self.phase not in ("READY", "ARMED"):
            return None

        if position.dx > LEFT_LOCAL_TRIGGER_MAX_POSITION_DX:
            return None

        best_confidence: float | None = None
        for sample in self.motion_samples[:-1]:
            if now - sample.created_at > LEFT_LOCAL_MOTION_SECONDS:
                continue

            start_position = sample.position
            if start_position.region != "near":
                continue

            if start_position.dx < LEFT_LOCAL_TRIGGER_MIN_START_DX:
                continue

            local_dx = position.dx - start_position.dx
            local_dy = position.dy - start_position.dy
            if local_dx > LEFT_LOCAL_TRIGGER_DX:
                continue

            if local_dy < LEFT_LOCAL_TRIGGER_DY:
                continue

            horizontal_score = min(local_dx / LEFT_LOCAL_TRIGGER_DX, 1.0)
            vertical_score = min(local_dy / LEFT_LOCAL_TRIGGER_DY, 1.0)
            confidence = (horizontal_score * 0.7) + (vertical_score * 0.3)
            if best_confidence is None or confidence > best_confidence:
                best_confidence = confidence

        shape_confidence = self.shape_gated_left_confidence(raw_frame, position, now)
        if shape_confidence is not None:
            if best_confidence is None or shape_confidence > best_confidence:
                best_confidence = shape_confidence

        return best_confidence

    def shape_gated_left_confidence(
        self,
        raw_frame: PatternFrame,
        position: RelativeHandPosition,
        now: float,
    ) -> float | None:
        if position.dx > LEFT_SHAPE_TRIGGER_MAX_POSITION_DX:
            return None

        if not is_left_open_trigger_shape(raw_frame):
            return None

        best_confidence: float | None = None
        for sample in self.motion_samples[:-1]:
            if now - sample.created_at > LEFT_LOCAL_MOTION_SECONDS:
                continue

            start_position = sample.position
            if start_position.region != "near":
                continue

            if start_position.dx < LEFT_SHAPE_TRIGGER_MIN_START_DX:
                continue

            local_dx = position.dx - start_position.dx
            local_dy = position.dy - start_position.dy
            if local_dx > LEFT_SHAPE_TRIGGER_DX:
                continue

            if local_dy < LEFT_SHAPE_TRIGGER_DY:
                continue

            horizontal_score = min(local_dx / LEFT_SHAPE_TRIGGER_DX, 1.0)
            vertical_score = min(local_dy / LEFT_SHAPE_TRIGGER_DY, 1.0)
            confidence = (horizontal_score * 0.6) + (vertical_score * 0.4)
            if best_confidence is None or confidence > best_confidence:
                best_confidence = confidence

        return best_confidence

    def should_record_open_palm_right(
        self,
        raw_frame: PatternFrame,
        position: RelativeHandPosition,
    ) -> bool:
        if self.anchor is None:
            return False

        if not self.anchor.enables_open_palm_right_trigger:
            return False

        if self.phase not in ("READY", "ARMED"):
            return False

        if position.dx < RIGHT_OPEN_TRIGGER_MIN_DX:
            return False

        if abs(position.dy) > RIGHT_OPEN_TRIGGER_MAX_ABS_DY:
            return False

        return is_right_open_trigger_shape(raw_frame)

    def should_record_fingertip_left(
        self,
        raw_frame: PatternFrame,
        position: RelativeHandPosition,
    ) -> bool:
        if self.anchor is None:
            return False

        if self.phase not in ("READY", "ARMED"):
            return False

        if position.region != "near":
            return False

        if abs(position.dy) > LEFT_FINGER_MAX_ABS_CENTER_DY:
            return False

        return are_fingertips_left_of_anchor(self.anchor, raw_frame)

    def should_record_fingertip_right(
        self,
        raw_frame: PatternFrame,
        position: RelativeHandPosition,
    ) -> bool:
        if self.anchor is None:
            return False

        if not self.anchor.enables_open_palm_right_trigger:
            return False

        if self.phase not in ("READY", "ARMED"):
            return False

        if position.region != "near":
            return False

        if position.dx > RIGHT_FINGER_MAX_CENTER_DX:
            return False

        if abs(position.dy) > RIGHT_FINGER_MAX_ABS_CENTER_DY:
            return False

        return are_fingertips_right_of_anchor(self.anchor, raw_frame)

    def relative_position(self, raw_frame: PatternFrame) -> RelativeHandPosition:
        if self.anchor is None:
            return RelativeHandPosition(dx=0.0, dy=0.0, region="away")

        center_x, center_y = pattern_palm_center(raw_frame)
        anchor_x, anchor_y = self.anchor.center
        dx = (center_x - anchor_x) / self.anchor.scale
        dy = (center_y - anchor_y) / self.anchor.scale
        region = classify_region(dx, dy)
        return RelativeHandPosition(dx=dx, dy=dy, region=region)

    def record_event(
        self,
        label: ActionLabel,
        position: RelativeHandPosition,
        now: float,
        confidence: float | None = None,
        return_requires_anchor_shape: bool = False,
    ) -> ActionEvent:
        event = ActionEvent(
            label=label,
            position=position,
            confidence=(
                position_confidence(position)
                if confidence is None
                else confidence
            ),
            created_at=now,
        )
        if label == "LEFT SWIPE":
            self.left_swipe_count += 1
        else:
            self.right_swipe_count += 1

        self.last_event = event
        self.cooldown_until = now + ACTION_COOLDOWN_SECONDS
        self.phase = "WAIT_RETURN"
        self.hand_lost_phase = None
        self.return_requires_anchor_shape = return_requires_anchor_shape
        self.motion_samples.clear()
        return event

    def headline(self, now: float) -> tuple[str, bool]:
        event = self.last_event
        event_is_visible = (
            event is not None
            and now - event.created_at <= ACTION_DISPLAY_SECONDS
        )
        if event_is_visible:
            return event.label, True

        if self.anchor is None:
            return "ANCHOR NOT SET", False

        if self.phase == "NO_HAND":
            return "NO HAND", False

        if self.phase == "WAIT_RETURN":
            return "RETURN TO ANCHOR", False

        if self.phase == "READY":
            return "ANCHOR READY", False

        return "TRACKING FROM ANCHOR", False

    def detail(self, now: float) -> str:
        event = self.last_event
        event_is_visible = (
            event is not None
            and now - event.created_at <= ACTION_DISPLAY_SECONDS
        )
        if event_is_visible:
            return event.debug_message()

        anchor_state = "set" if self.anchor is not None else "not_set"
        position_state = "pos=none"
        if self.current_position is not None:
            position_state = (
                f"region={self.current_position.region} "
                f"dx={self.current_position.dx:.2f} dy={self.current_position.dy:.2f}"
            )

        return (
            f"anchor={anchor_state} phase={self.phase} {position_state}"
        )

    def count_message(self) -> str:
        return f"LEFT SWIPES: {self.left_swipe_count}   RIGHT SWIPES: {self.right_swipe_count}"


def classify_region(dx: float, dy: float) -> AnchorRegion:
    is_near_anchor = (
        abs(dx) <= ANCHOR_NEAR_HORIZONTAL_RADIUS
        and abs(dy) <= ANCHOR_NEAR_VERTICAL_RADIUS
    )
    if is_near_anchor:
        return "near"

    if dx <= LEFT_TRIGGER_DX and dy >= LEFT_TRIGGER_MIN_DY:
        return "left_trigger"

    if dx >= RIGHT_TRIGGER_DX:
        return "right_trigger"

    return "away"


def hand_width_and_aspect(raw_frame: PatternFrame) -> tuple[float, float]:
    xs = [point[0] for point in raw_frame]
    ys = [point[1] for point in raw_frame]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    return width, width / max(height, 0.001)


def is_anchor_return_shape(raw_frame: PatternFrame) -> bool:
    width, aspect = hand_width_and_aspect(raw_frame)
    return width <= ANCHOR_RETURN_MAX_WIDTH or aspect <= ANCHOR_RETURN_MAX_ASPECT


def is_right_open_trigger_shape(raw_frame: PatternFrame) -> bool:
    width, aspect = hand_width_and_aspect(raw_frame)
    return (
        width >= RIGHT_OPEN_TRIGGER_MIN_WIDTH
        and aspect >= RIGHT_OPEN_TRIGGER_MIN_ASPECT
        and index_pinky_dx(raw_frame) <= RIGHT_OPEN_TRIGGER_MAX_INDEX_PINKY_DX
    )


def is_left_open_trigger_shape(raw_frame: PatternFrame) -> bool:
    width, aspect = hand_width_and_aspect(raw_frame)
    return (
        width >= LEFT_SHAPE_MIN_WIDTH
        and aspect >= LEFT_SHAPE_MIN_ASPECT
        and index_pinky_dx(raw_frame) >= LEFT_SHAPE_MIN_INDEX_PINKY_DX
    )


def are_fingertips_left_of_anchor(
    anchor: AnchorSnapshot,
    raw_frame: PatternFrame,
) -> bool:
    index_dx, middle_dx, ring_dx, pinky_dx = (
        relative_x_from_anchor(anchor, raw_frame[tip_index])
        for tip_index in LEFT_FINGER_TIP_INDICES
    )
    return (
        index_dx <= LEFT_FINGER_MIN_INDEX_DX
        and middle_dx <= LEFT_FINGER_MIN_MIDDLE_DX
        and ring_dx <= LEFT_FINGER_MIN_RING_DX
        and pinky_dx <= LEFT_FINGER_MIN_PINKY_DX
        and index_pinky_dx(raw_frame) >= LEFT_FINGER_MIN_INDEX_PINKY_DX
    )


def are_fingertips_right_of_anchor(
    anchor: AnchorSnapshot,
    raw_frame: PatternFrame,
) -> bool:
    index_dx, middle_dx, ring_dx, pinky_dx = (
        relative_x_from_anchor(anchor, raw_frame[tip_index])
        for tip_index in RIGHT_FINGER_TIP_INDICES
    )
    return (
        index_dx >= RIGHT_FINGER_MIN_INDEX_DX
        and middle_dx >= RIGHT_FINGER_MIN_MIDDLE_DX
        and ring_dx >= RIGHT_FINGER_MIN_RING_DX
        and pinky_dx >= RIGHT_FINGER_MIN_PINKY_DX
        and index_pinky_dx(raw_frame) <= RIGHT_FINGER_MAX_INDEX_PINKY_DX
    )


def relative_x_from_anchor(
    anchor: AnchorSnapshot,
    point: tuple[float, float],
) -> float:
    anchor_x, _anchor_y = anchor.center
    return (point[0] - anchor_x) / anchor.scale


def index_pinky_dx(raw_frame: PatternFrame) -> float:
    scale = pattern_hand_scale(raw_frame)
    return (raw_frame[2][0] - raw_frame[8][0]) / scale


def position_confidence(position: RelativeHandPosition) -> float:
    if position.region == "left_trigger":
        horizontal_score = min(abs(position.dx / LEFT_TRIGGER_DX), 1.0)
        vertical_score = min(position.dy / max(LEFT_TRIGGER_MIN_DY, 0.001), 1.0)
        return (horizontal_score * 0.75) + (vertical_score * 0.25)

    if position.region == "right_trigger":
        horizontal_score = min(position.dx / RIGHT_TRIGGER_DX, 1.0)
        return horizontal_score

    return 0.0
