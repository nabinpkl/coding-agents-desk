"""Generate the golden-vector fixture for the TypeScript ActionTracker port.

Runs a fixed set of real recorded landmark sessions through the authoritative
Python ``ActionTracker`` under one explicit driver, and dumps every input frame
plus the tracker's output so the TS test can replay the same inputs and assert
byte-identical results.

Driver convention (mirrored exactly in action-tracker.golden.test.ts):
  - Set the anchor on the FIRST frame that has a hand (that frame is not
    update()'d; updates start from the next frame).
  - For each following frame in order: hand present -> update(hand, elapsed);
    hand null -> mark_no_hand() and no event.

Regenerate:  uv run python web/src/features/gesture/tracker/__fixtures__/generate_golden.py
The fixture is committed; this script exists so it stays reproducible.
"""

import json
from pathlib import Path

from interaction_agent.gesture.action.tracker import ActionEvent, ActionTracker

REPO_ROOT = Path(__file__).resolve().parents[6]
RECORDING_ROOT = REPO_ROOT / "data" / "gesture" / "recordings"
OUT_PATH = Path(__file__).resolve().parent / "golden.json"

# A fixed, curated subset: both swipe directions plus an ambiguous session, so
# the fixture exercises LEFT, RIGHT, and no-fire paths. Sorted for determinism.
SELECTED = [
    "left_swipe/session-20260530-011412-361933.json",
    "left_swipe/session-20260530-042759-240231.json",
    "right_swipe/session-20260530-034739-987694.json",
    "right_swipe/session-20260530-040130-147830.json",
    "unknown/session-20260530-032305-030298.json",
]


def event_payload(event: ActionEvent | None) -> dict | None:
    if event is None:
        return None
    return {
        "label": event.label,
        "dx": event.position.dx,
        "dy": event.position.dy,
        "region": event.position.region,
        "confidence": event.confidence,
        "createdAt": event.created_at,
    }


def run_session(frames: list[dict]) -> dict:
    tracker = ActionTracker()
    anchor_index: int | None = None
    steps: list[dict] = []

    for index, frame in enumerate(frames):
        hand = frame["hand"]
        elapsed = frame["elapsedSeconds"]
        if hand is None:
            if anchor_index is not None:
                tracker.mark_no_hand()
            steps.append({"i": index, "event": None})
            continue

        raw = tuple((float(p[0]), float(p[1])) for p in hand)
        if anchor_index is None:
            anchor_index = index
            tracker.set_anchor(raw, elapsed)
            steps.append({"i": index, "event": None})
            continue

        event = tracker.update(raw, elapsed)
        steps.append({"i": index, "event": event_payload(event)})

    return {
        "anchorIndex": anchor_index,
        "steps": steps,
        "leftCount": tracker.left_swipe_count,
        "rightCount": tracker.right_swipe_count,
    }


def main() -> None:
    sessions = []
    for relative in SELECTED:
        path = RECORDING_ROOT / relative
        recording = json.loads(path.read_text())
        frames = recording["frames"]
        result = run_session(frames)
        sessions.append(
            {
                "name": relative,
                "frames": frames,
                **result,
            }
        )
        fired = sum(1 for s in result["steps"] if s["event"] is not None)
        print(
            f"{relative}: {len(frames)} frames, anchor@{result['anchorIndex']}, "
            f"L={result['leftCount']} R={result['rightCount']} fired={fired}"
        )

    OUT_PATH.write_text(json.dumps({"sessions": sessions}))
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
