---
status: proposed
date: 2026-05-23
---

# Spaces thumbnail capture for the iPhone preview strip

## Context and Problem Statement

The iPhone client currently shows a single Mac display via WebRTC plus a dots band that names the count of user Spaces but not their contents. R20 adds a thumbnail strip in the dead band below the screen-share so the user can glance at every other Space before swiping. The architectural questions are (a) how the host captures off-active-Space windows on macOS 26 and beyond, (b) what cadence the host pushes thumbnails at, and (c) what wire shape carries them. The affected modules are `host/AgentDeskHost/SpaceThumbnailProvider.swift` (new), `host/AgentDeskHost/InputChannelServer.swift`, the mirrored `SharedTypes.swift` on both sides, and `client/AgentDeskClient/ThumbnailStripView.swift` (new).

## Decision Drivers

- Stay on macOS-supported APIs where available, since the SkyLight surface this project already uses for Spaces enumeration is one upgrade away from a behaviour change. Adding another private surface in the same codebase compounds that risk.
- Re-use the Screen Recording permission the host already holds via `ScreenCaptureKitFrameSource.swift`. The user has already paid the TCC cost once for the main video stream; the thumbnail path must not demand a second subject grant.
- Keep `DesktopState` event-driven. Today it pushes on Space change. Bolting thumbnails (which want a periodic refresh) onto the same frame would either bloat every push or force a synthetic push every few seconds.
- Default to off. The phone may be unattended in a context where the Mac is not; an always-on thumbnail mirror is a passive leak vector.

## Considered Options

- **Option A: ScreenCaptureKit + `SLSCopySpacesForWindows`.** Use `SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)` to enumerate windows including off-Space ones, query SkyLight per-window to map windowID → spaceID, capture each window via `SCContentFilter(desktopIndependentWindow:)` + `SCScreenshotManager.captureImage`, composite by window bounds.
- **Option B: Private `SLSHWCaptureWindowList`.** The path AltTab, Mission Control, and the Dock use. Bypasses the Screen Recording prompt entirely; returns rendered window contents from the WindowServer directly. One more private symbol on the SkyLight handle SpacesProvider already holds.
- **Option C: Merge thumbnails into every `DesktopStatePush`.** No new wire frame; cadence is dictated by Space-change events plus a 3 s synthetic push that carries a stale-or-fresh DesktopState alongside the thumbnails.

## Decision Outcome

Chose **Option A** for capture and a **separate `thumbnails-push` frame** (rejecting Option C) for the wire shape.

Option A wins on the maintained-surface driver. `ScreenCaptureKit` is the path Apple keeps documenting and updating; `SLSHWCaptureWindowList` is at the same upgrade risk as the rest of the SkyLight surface, plus its undocumented-ness compounds investigation cost when the next macOS minor breaks it. The "bypasses Screen Recording prompt" benefit of Option B does not apply here, because the host already holds Screen Recording for the main video stream; the thumbnail path inherits it. The compositor cost (CGContext + per-window draw + JPEG encode) is acceptable for a 3 s cadence with at most ~6 Spaces.

The separate `thumbnails-push` frame wins on the event-driven driver. `DesktopState` fires on Space changes and channel attach; thumbnails want a refresh cadence independent of those triggers. Two frames let each carry its own timing without contaminating the other. Disabled clients pay zero bytes for thumbnails because the host never captures and never pushes when `client-config { thumbnailsEnabled: false }` is the current state.

Active-Space capture is dropped: WebRTC already streams the active Space at 60 fps, and the strip renders a "you're here" placeholder for it. Capturing it would burn Mac CPU for zero information gain.

### Consequences

- Good, because the host's existing TCC posture is enough; no new prompt for the user.
- Good, because thumbnails arrive on their own cadence and the `DesktopState` push path stays event-driven.
- Good, because the off-by-default privacy posture is honest about the leak surface and lets the user opt in once.
- Bad, because per-window SCK capture is more work than a single `SLSHWCaptureWindowList` call. On a workstation with 20+ visible windows across all Spaces this is measurable; mitigated by capping capture at ~6 candidate windows per Space (filter out menu-bar, dock, wallpaper, sub-50pt windows).
- Bad, because the SkyLight surface gains one more symbol (`SLSCopySpacesForWindows`). Same upgrade risk profile as `SpacesProvider`'s existing three, but the failure mode is now "the strip goes empty," not "Spaces stop working," which the user surfaces as soon as the strip is enabled.
- Neutral, because choosing a 3 s refresh cadence is a guess. If thumbnails feel stale, the constant is one knob away; the wire shape doesn't change.

### Confirmation

- Live integration in R20.1 verifies SCK returns current bitmaps for off-Space windows on the developer's macOS 26.4 workstation. The spike attempt (host/scripts/thumbnails-spike.swift, 2026-05-23) confirmed the SkyLight enumeration half but stalled on the `swift` interpreter's separate TCC subject; the host-process integration sidesteps that.
- `SpaceThumbnailProviderTests` covers the pure compositor; a live SCK smoke test gated like `SpacesProviderTests`' live smoke acts as the macOS-upgrade canary.
- Wire-shape test in `InputChannelServerTests`: an enabled client receives a non-empty `thumbnails-push` within one timer tick of the channel opening; a disabled client never receives any.

## Pros and Cons of the Options

### Option A: ScreenCaptureKit + `SLSCopySpacesForWindows`

- Good, because SCK is the surface Apple maintains across macOS releases.
- Good, because the host already has the Screen Recording TCC grant for the main video stream.
- Neutral, because `SCContentFilter(desktopIndependentWindow:)` is a per-window call and the composite is custom code, not a single API.
- Bad, because the compositor has to handle window bounds relative to display origin and Y-axis flips.

### Option B: Private `SLSHWCaptureWindowList`

- Good, because the WindowServer returns the rendered bitmap directly with no compositor work.
- Good, because no TCC subject is involved at all.
- Bad, because the surface is undocumented and at the same upgrade risk as the rest of SkyLight.
- Bad, because adopting it adds a fourth private symbol to the project's macOS upgrade-canary surface; SpacesProvider already carries three.

### Option C: Merge thumbnails into `DesktopStatePush`

- Good, because no new wire frame type.
- Bad, because `DesktopState` becomes a hybrid event/timer push; either the timer drives synthetic state pushes or thumbnails arrive bursty alongside Space changes.
- Bad, because every `DesktopState` push carries the full thumbnail set when enabled, even if only the active-Space pointer changed.

## Links

- SPEC §Module boundaries (to be updated in the same slice).
- ADR-0001 v0 stack and transport.
- ADR-0005 input channel separation (the WSS path that the new frames ride on).
- AltTab `WindowApi.swift` (canonical reference for off-Space window enumeration on macOS), https://github.com/lwouis/alt-tab-macos/blob/master/src/api-wrappers/WindowApi.swift (no date verifiable; project is actively maintained as of 2026).
- Apple developer docs for `SCContentFilter(desktopIndependentWindow:)`, https://developer.apple.com/documentation/screencapturekit/sccontentfilter (no date verifiable).
