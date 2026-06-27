---
status: accepted
date: 2026-06-27
---

# Selected display projection on the client

## Context and Problem Statement

AgentDesk originally modeled multiple host displays in `DesktopState`, but v0 projected only the active display to the iPhone. Multi-monitor control needs a client-visible display choice without overloading the existing Spaces strip, because horizontal sliding already means "switch desktop on this display." The affected paths are `DesktopState`, `ClientConfig`, `SpacesProvider`, `ScreenCaptureKitFrameSource`, `InputDispatcher`, and the client control surface.

## Decision Drivers

- Display selection and Space switching must stay independent. A swipe in the Spaces strip must not sometimes mean "switch monitor."
- The host remains the source of truth for displays, Space membership, display labels, and display bounds.
- Capture and input must target the same selected display, otherwise the iPhone could view one monitor while moving the cursor on another.
- The existing reliable input/config lane is already authenticated and ordered, so display selection should reuse it instead of adding another control path.

## Considered Options

- **Option A: tap-based display rail plus selected-display state.** The client renders a separate labeled display rail and sends the selected display id in `ClientConfig`.
- **Option B: horizontal display swipe on the existing Spaces strip.** Reuse the strip gesture and infer display switching at strip edges.
- **Option C: mirror macOS active display only.** Keep following whichever display WindowServer reports as active.

## Decision Outcome

Chose **Option A**. Display selection is tap-based in a separate client rail, and Space sliding remains scoped to the selected display's user Spaces. `DesktopState.selectedDisplayId` tells the client what AgentDesk is projecting; `activeDisplayId` remains the macOS active-display observation. The host applies selected display changes by switching ScreenCaptureKit capture, clamping input against that display's bounds, and forcing the first post-switch frame to be a keyframe.

### Consequences

- Good, because the client can label displays and switch projection without changing the Space swipe contract.
- Good, because capture, input, and cursor edge-follow all consume one selected-display source of truth.
- Bad, because display switches restart the ScreenCaptureKit stream. That is acceptable for a tap-based monitor change, but it is not a gesture-continuous animation.
- Neutral, because `activeDisplayId` remains in the wire shape for macOS observations and host-side Space Agent behavior.

### Confirmation

`ThumbnailStripViewTests` assert that the Spaces strip filters by `selectedDisplayId` when present, and `DisplaySelectionStore` rejects unavailable display ids. `just check` covers host and client builds plus the focused tests.

## Links

- SPEC wire shapes for `DesktopState` and `ClientConfig`.
- ADR-0009 cursor-driven viewport pan.
- ADR-0030 single QUIC session transport.
