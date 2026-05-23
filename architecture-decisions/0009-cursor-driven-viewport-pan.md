---
status: proposed
date: 2026-05-23
---

# Cursor-driven viewport pan (edge follow)

## Context and Problem Statement

R21 + ADR-0008 left the iPhone client with a smooth local pinch zoom and a baseline stream sharp enough that local zoom up to ~4x is readable. Past 1.0x, though, the visible window stays parked wherever the user last panned it. When the trackpad moves the cursor outside that window, the user has to break the cursor flow, two-finger pan to find the cursor, then resume. Every shipping remote-desktop client on iOS (Microsoft RDP "stick to your finger and follow it around", AnyDesk "edge scrolling in original view mode", NoMachine, RealVNC) solves the same problem the same way: the visible window follows the cursor. The cursor pushes against the viewport edge; the viewport scrolls underneath until the cursor reaches the actual display edge.

Three properties of the current code make this cheap to implement without changing the cursor wire:

- `InputDispatcher.postCursorMove` posts CGEvents with absolute `mouseCursorPosition`, computed as `currentLocation + delta` clamped to `CGDisplayBounds`. No HID pointer ballistics run on injected events; the file documents this directly. The acceleration curve is entirely client-side in `GestureTranslator`.
- `ScreenCaptureKitFrameSource` sets `config.showsCursor = true`, so the cursor is baked into the captured video. No separate client-side cursor render is needed.
- `NormalizedInput.cursorMove(dx, dy)` already carries the accelerated deltas.

So a client-side cursor model that integrates the same deltas and clamps against the same display bounds will stay in lockstep with the host. The single thing the client did not know was the host's display dimensions.

Affected modules: `host/AgentDeskHost/SharedTypes.swift`, `host/AgentDeskHost/SpacesProvider.swift`, `client/AgentDeskClient/SharedTypes.swift`, `client/AgentDeskClient/PairingViewController.swift`, `client/AgentDeskClient/EdgeFollow.swift` (new).

## Decision Drivers

- The felt friction is "I can't find my cursor when zoomed". Anything that keeps the cursor visible inside the viewport without breaking the cursor flow solves it.
- Wire shape minimalism. Display dimensions are a property the client could ask for once and reuse; piggybacking on the existing `DesktopState` push frame avoids a new message type.
- Drift between the client's predicted cursor and the host's actual cursor must stay bounded. If the two diverge, the viewport panning chases a position that does not match the cursor visible in the video.
- The cursor is already baked into the video. A separate client-rendered cursor overlay is optional; defer until measurable latency makes it the felt friction.

## Considered Options

- **Option A: client-only delta integration + display bounds on wire.** Client mirrors the host's `current + delta + clamp` logic. Pushes display width/height via `DesktopState`. No new push frame from host. Drift bounded by client and host agreeing on the same clamp.
- **Option B: host pushes cursor position back to client.** Authoritative, no drift even if host and client clamp logic diverges. Costs a new frame on the input WSS at the cursor-event cadence (~16 bytes at up to 60 Hz, modest).
- **Option C: switch to absolute-position cursor wire (`cursorMoveAbsolute(x, y)`).** Client computes the absolute position, sends it on the wire. Host applies it directly. No drift, no extra frames. Breaks the existing `GestureTranslator.acceleration` model because the acceleration curve currently shapes deltas, not positions.
- **Option D: also draw a local cursor overlay on the iPhone.** Removes any perceptible round-trip lag at the cost of a small CALayer overlay and a fade-to-merge dance when the host's video cursor catches up.

## Decision Outcome

Chose **Option A**.

The host already implements its own `current + delta + clamp` against `CGDisplayBounds`, so the client mirroring that logic produces identical positions provided both use the same bounds. Pushing display dimensions in `DesktopState.displays[i].widthPoints/heightPoints` is the minimum wire addition needed. No new frame type, no host->client cursor push, no acceleration model rewrite, no overlay yet.

The cursor wire (`NormalizedInput.cursorMove(dx, dy)`) is unchanged. The host's `InputDispatcher` is unchanged.

Edge-follow logic lives in a pure function `EdgeFollow.contentOffset(...)`, separate from `PairingViewController` so it can be unit tested.

v0 is single-display. The host stamps every `DisplayMetadata` with `CGDisplayBounds(CGMainDisplayID())` because both `ScreenCaptureKitFrameSource` and `InputDispatcher` target the main display by default. Multi-monitor will need UUID-to-displayID matching to disambiguate, captured as a v1 follow-up.

### Consequences

- Good, because the felt friction (cursor escaping the visible window) is gone without adding a host->client cursor push frame or rewriting the acceleration model.
- Good, because the wire addition is one extension to an existing frame (`DesktopState` already fires on Space changes and at session start).
- Good, because `EdgeFollow` is pure-function and tested without UIKit, so the math is verifiable independent of UIScrollView's state.
- Bad, because the predicted cursor and the host cursor in the video are technically allowed to diverge if the clamp logic ever drifts (different display selected, race between display change and a cursor event). For v0 single-display this can't happen meaningfully; multi-display will need either Option B or shared clamp logic via an explicit display-bounds field carried with each cursor event.
- Bad, because at network round-trips above ~50ms the user can see the local viewport panning before the host's cursor visibly catches up. If this becomes the felt friction, layer on Option D.
- Neutral, because the edge margin (12% on each side) is a knob. Tighter = more panning churn; looser = cursor goes further off-centre before the viewport responds. Reviewable from daily-driver use.

### Confirmation

- `EdgeFollowTests` covers the pure-function math: safe-band noop, right-edge pulls offset, left-edge pulls offset, top/bottom symmetry, zoom=1 clamps, degenerate display, cursor advance + clamp.
- Live integration: zoom past 1.0x on the iPhone, drive the trackpad; the viewport must follow the cursor toward all four edges and stop at the display edge.
- No host-side test additions; the host change is one field assignment in `SpacesProvider.current()` that the existing smoke path exercises.

## Pros and Cons of the Options

### Option A (chosen)

- Good, because zero new frame types and zero host changes outside `SpacesProvider`.
- Good, because the cursor model integrates the same shape the host already integrates, so no acceleration mismatch.
- Bad, because relies on client and host agreeing on display bounds. Single-display v0 trivially does; multi-display needs work.

### Option B

- Good, because authoritative, never drifts.
- Bad, because adds a host-initiated frame at cursor cadence and a new state machine on both sides.

### Option C

- Good, because removes deltas from the wire entirely; positions are self-describing.
- Bad, because rewires `GestureTranslator.acceleration` (curve is currently applied to deltas) and changes the failure mode if the client's display-bounds knowledge is stale.

### Option D

- Good, because removes round-trip lag perception at high latency.
- Bad, because adds an overlay layer and a fade-to-merge interaction we haven't proven is needed.

## Links

- ADR-0001 v0 stack and transport.
- ADR-0005 input channel separation (carries the `cursorMove` wire).
- ADR-0008 native-pixel encoder density (the context where zoom became usable).
- Microsoft Remote Desktop for iOS feature documentation (Mouse Pointer mode behavior).
- AnyDesk display settings (edge scrolling in original view mode).
