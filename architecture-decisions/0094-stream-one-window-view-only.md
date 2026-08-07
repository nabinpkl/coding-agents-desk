---
status: accepted
date: 2026-08-07
---

# Stream one window, view-only, instead of the whole Desktop

## Context and Problem Statement

The iPhone can only watch a whole macOS display. `ScreenCaptureKitFrameSource` builds
`SCContentFilter(display:excludingWindows:)` and sizes the stream from the display's points
times `NSScreen.backingScaleFactor`, with target selection carried by a single host-global
`selectedDisplayId` flowing from `ClientConfig` through `DisplaySelectionStore`.

Every frame therefore carries the wallpaper, menu bar, Dock, and every other window, whether
or not the viewer cares about any of it. On a phone the thing usually worth watching is one
window -- a build log, an agent session, a browser tab -- and often one that is not even on
the active Desktop. This touches the capture engine (`ScreenCaptureKitFrameSource`,
`VideoFrameSource`), the client-config wire shape, host input dispatch (`AppDelegate`'s input
loop, `InputDispatcher`), and the client's Control-surface chrome.

Measured on this Mac with the host's own encoder settings (HEVC, hardware-required,
low-latency rate control, realtime, no frame reordering, LTR), whole desktop versus one
editor window:

| | desktop 3600x2338 | window 1980x1536 |
|---|---|---|
| bitrate, non-binding cap | 3084 kbps | 518 kbps |
| bitrate at the host's real 2500 kbps cap | 2113 kbps | 551 kbps |
| frames emitted / captured at that cap | 258 / 283 | 346 / 353 |
| largest keyframe | 449 KB | 77 KB |
| average delta | 4064 B | 917 B |

Pixel area differs by 2.8x but bitrate by 4-6x and deltas by 4-10x, because wallpaper,
chrome, and neighbouring windows all generate change a window filter never sees. At the
pinned 2500 kbps the desktop path is against its ceiling and shedding ~9% of captures; one
window sits at ~22% of budget and sheds ~2%. Keyframes, which stall recovery injects exactly
when the link is worst, drop from about 1.4s of a 2500 kbps link to about 0.25s.

## Decision Drivers

- Bandwidth: the phone link is the binding constraint, and quality is pinned manually rather
  than adaptively, so the win has to come from sending less, not from a ladder.
- Off-Desktop reach: the windows most worth watching from a phone are the ones not on the
  active Space. A solution that only works for visible windows misses the point.
- No blind input: `InputDispatcher` posts global `CGEvent`s in display coordinates and has no
  per-window routing.
- No surprise cost: a fallback that silently reverts to display capture is a 4-6x bandwidth
  jump nobody asked for.
- Do not regress the display path, which is the daily driver.

## Considered Options

- **Option A**: `SCContentFilter(desktopIndependentWindow:)` -- a filter that renders one
  window unoccluded, independent of which Space it is on.
- **Option B**: Keep the display filter and crop to the window's rect via `sourceRect`.
- **Option C**: `SCContentFilter(display:including:)` with a single window -- display-shaped
  canvas, only that window composited.

## Decision Outcome

Chose **Option A**. Only it satisfies off-Desktop reach: a window on another Space has no
meaningful rect on the current display, which knocks out Option B outright. Option C keeps
the display-sized canvas, so it pays full-surface encode cost for a small window and gives up
most of the bandwidth driver. Option A was measured live at ~57fps for windows that are not
on screen, at native scale, with real pixels.

Four further choices ride with it:

1. **The wire field is additive.** `ClientConfig` gains `selectedWindowId: UInt32?` alongside
   `selectedDisplayId`, which keeps owning the input coordinate space, `DesktopState`, and
   thumbnail refresh. The two are exclusive only at the capture filter, where
   `AppDelegate.applyCaptureTarget()` is the single writer.
2. **View-only is enforced on the host**, in the input loop, not by hiding client chrome.
   Client-side hiding is presentation honesty; a host that trusts it would post blind clicks
   on a display the viewer cannot see the moment any peer disagrees. Space navigation stays
   allowed, because the Spaces strip sits directly above the picker and its tiles promise to
   switch Desktops.
3. **Target loss holds and reports.** An uncapturable window (minimized, app hidden) yields
   zero frames and `SCFrameStatus.suspended` with **no** stream error -- `didStopWithError`
   never fires. That status is the only signal, so it drives the existing
   `.captureUnavailable` host availability rather than a silent fallback to display capture.
4. **Window identity is a bare `CGWindowID`, loudly lost.** No re-resolve by app plus title
   after a restart: a wrong re-resolve silently streams a different window, which is worse
   than an empty picker entry the user re-taps.

### Consequences

- Good, because the bandwidth-bound case gets 4-6x headroom without touching quality
  settings, and keyframes stop costing over a second of link time.
- Good, because windows on other Desktops become watchable at all, which the display path
  cannot express.
- Bad, because a window target is view-only. Watching and driving are now different modes,
  and the user has to leave window mode to touch anything.
- Bad, because a window resized mid-stream scales into the dimensions captured at start.
  Visibly imperfect, not broken; live `updateContentFilter` / `updateConfiguration` is
  deliberately deferred.
- Neutral, because the capture target is host-global and last-writer-wins, matching
  `DisplaySelectionStore`. Two clients watching one host already share a display selection.
- Neutral, because damage under a window filter is full-surface on ~95% of frames versus
  0/2150 under the display filter. Irrelevant while crisp is off, which it is by default on
  both sides; it becomes a real cost if the crisp/tile path is ever re-enabled.

### Confirmation

`WindowCaptureTargetTests` pins the view-only gate case by case, deliberately without a
`default:` arm, so a new `NormalizedInput` case has to make the allow/deny choice explicitly
rather than defaulting into the permissive half. `WireRoundTripTests` pins that an absent
`sw` key decodes as "no window" rather than window 0. Host-side the signal is the
`capture target=` and `input dropped: view-only window capture` log lines.

## Links

- SPEC §1 (CaptureEngine), §18 (VideoFrameSource)
- ADR-0008 encode at native pixel density
- ADR-0021 OS-provided damage regions
- ADR-0027 windowed byte ceiling (`DataRateLimits`), which still fires in manual quality mode
- ADR-0050 wire types single source of truth
