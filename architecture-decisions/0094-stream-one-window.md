---
status: accepted
date: 2026-08-07
---

# Stream and drive one window instead of the whole Desktop

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
- Live pixels, not a still: a window on an inactive Space captures at full frame rate but its
  app has stopped drawing, so the stream is a frozen image delivered 57 times a second. This
  was measured after the first cut shipped and it is what forced the switch-and-show design
  below. "Reachable" is not the same as "watchable".
- Drivable: a phone that can only look at a build log is worth much less than one that can
  scroll it and type into it. `InputDispatcher` posts global `CGEvent`s in display
  coordinates and has no per-window routing, so whatever makes the pixels live has to also be
  what makes the events land.
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

Six further choices ride with it:

1. **The wire field is additive.** `ClientConfig` gains `selectedWindowId: UInt32?` alongside
   `selectedDisplayId`, which keeps owning the input coordinate space, `DesktopState`, and
   thumbnail refresh. The two are exclusive only at the capture filter, where
   `AppDelegate.applyCaptureTarget()` is the single writer.
2. **Selecting a window switches the Mac to it and raises it** (switch-and-show), and the
   window is fully drivable. The first cut of this ADR made window mode view-only, enforced
   in the host's input loop, on the reasoning that global `CGEvent`s aimed at a window the
   Mac is not showing are blind clicks. That reasoning was right and the conclusion was
   wrong: the same fact that makes input blind -- the window is not on the active Space --
   is what makes its pixels frozen, so view-only bought a still picture. Raising the window
   fixes both at once. The host reuses the Dock strip's `DockWindowFocusExecutor`
   (ADR-0055), so there is one implementation of "switch Space and raise this window", and
   the cursor is clamped to the window's rect (`CaptureTargetStore.cursorBounds` feeding
   `InputDispatcher`'s `displayBoundsProvider`) so the trackpad cannot wander into pixels the
   viewer is not being shown.
   Leaving window mode returns the Mac to whichever Desktop was active when window mode was
   entered. That memory is held across window-to-window hops and consumed exactly once, so a
   second exit cannot yank the Mac away from wherever the user has since navigated.
   Because the pointer now matters and the client's cursor overlay is drawn in display
   points, which window pixels are not, window mode forces `showsCursor` on in the capture:
   the real pointer is baked into the video and the client dot stays hidden.
3. **Fitting the window is one captured pixel per phone pixel.** Selecting a window also
   resizes it, through Accessibility (`kAXSize`/`kAXPosition`), to the size that makes its
   captured pixels equal the client's video viewport pixels -- 603x722 points for a
   1206x1443 viewport on a 2x display. The goal is readable remote text, and that is a
   computable optimum rather than a taste call. Text on the phone gets larger as the window
   gets smaller, because the phone's fixed viewport then shows fewer Mac points; but below
   the matching size the phone starts upscaling, which blurs exactly the small glyphs being
   read, and HEVC at a pinned bitrate makes that worse. Matching pixels is therefore the
   largest text achievable with no resampling anywhere in the chain. Measured against the
   alternatives on a 1800x1105 pt visible frame with a 1206x1443 px viewport: maximizing to
   the viewport's aspect renders 13 pt Mac text at 5.7 pt on the phone, keeping the window's
   current area gives 10.8 pt with a 1.24x upscale, and matching pixels gives 8.7 pt with
   none. It also encodes 1.74 Mpx instead of 4.08, so the pinned bitrate goes further per
   pixel. The window keeps the centre the user left it at, clamped inside the display, rather
   than being centred on the display, which would move every picked window to the same place.
4. **The fit is released on every change of target, not just on exit.** Each window's
   pre-fit frame is remembered once and handed back exactly once, when it stops being the
   watched window: tapping Whole Desktop, picking a different window, or ending the session.
   Remembered once so a re-fit cannot overwrite the user's real geometry with the fitted one
   and make the restore a silent no-op; handed back once so a window whose app has quit is
   dropped rather than retried forever.
   Ordering is load-bearing and is the reason the release runs before the Space switch:
   Accessibility only lists an app's windows on the **active** Space, so once the Mac leaves
   the fitted window's Desktop that window is out of reach and would be stranded at the
   phone's size. This is also why fitting happens after the raise, not before.
   Two failures are accepted rather than worked around. A fixed-size window answers `kAXSize`
   with `kAXErrorFailure`; nothing moved, so nothing is owed back, and it streams at its own
   size with the phone letterboxing it. And a host that dies mid-session leaves the window
   fitted, because the memory is in-process; the user resizes it back by hand.
5. **Target loss holds and reports.** An uncapturable window (minimized, app hidden) yields
   zero frames and `SCFrameStatus.suspended` with **no** stream error -- `didStopWithError`
   never fires. That status is the only signal, so it drives the existing
   `.captureUnavailable` host availability rather than a silent fallback to display capture.
6. **Window identity is a bare `CGWindowID`, loudly lost.** No re-resolve by app plus title
   after a restart: a wrong re-resolve silently streams a different window, which is worse
   than an empty picker entry the user re-taps.

### Consequences

- Good, because the bandwidth-bound case gets 4-6x headroom without touching quality
  settings, and keyframes stop costing over a second of link time.
- Good, because windows on other Desktops become watchable at all, which the display path
  cannot express.
- Bad, because picking a window has a visible side effect on the Mac: it switches Space and
  raises a window, which someone sitting in front of the Mac will see. The Spaces strip
  directly above the picker already switches Desktops, so the surface is not new, but the
  picker no longer has the "changes nothing on the Mac" property the first cut promised.
- Bad, because window mode cannot show a window and the Desktop behind it at once. The
  window is raised, so it is on top of whatever it overlaps.
- Bad, because picking a window now also resizes it. The size is given back on every exit,
  but a host that dies mid-session cannot give it back, and a window whose app has since
  moved to another Desktop is out of Accessibility's reach and stays fitted.
- Bad, because a window resized mid-stream scales into the dimensions captured at start.
  The fit works around this by restarting the capture, which costs one keyframe at exactly
  the moment the picture changes anyway; a window the *user* resizes on the Mac still scales
  into the old buffer. Live `updateContentFilter` / `updateConfiguration` is still deferred.
- Neutral, because the capture target is host-global and last-writer-wins, matching
  `DisplaySelectionStore`. Two clients watching one host already share a display selection.
- Neutral, because damage under a window filter is full-surface on ~95% of frames versus
  0/2150 under the display filter. Irrelevant while crisp is off, which it is by default on
  both sides; it becomes a real cost if the crisp/tile path is ever re-enabled.

### Confirmation

`WindowCaptureTargetTests` pins the two behaviours the store owns beyond holding an id: that
a moved window updates the cursor clamp without reporting a target change (which would
needlessly restart capture and force a keyframe), and that the Desktop owed back on exit
survives window-to-window hops and is handed out exactly once. `WindowFitMemoryTests` pins
the per-window half: the previous window is owed its frame back while the watched one is
kept, a re-fit does not overwrite the remembered geometry, and each frame is handed out
once. `WindowFitGeometryTests` pins the pixel-matching rule itself, including that an
already-fitted window reports unchanged rather than paying a capture restart for nothing. `WireRoundTripTests` pins that
an absent `sw` key decodes as "no window" rather than window 0. Host-side the signals are the
`capture target=`, `window selection unresolved`, `window focus failed`, `window fit`,
`window fit failed`, and `window fit released` log lines.

## Links

- SPEC §1 (CaptureEngine), §18 (VideoFrameSource)
- ADR-0008 encode at native pixel density
- ADR-0055 Dock window focus executor, reused here for switch-and-show
- ADR-0021 OS-provided damage regions
- ADR-0027 windowed byte ceiling (`DataRateLimits`), which still fires in manual quality mode
- ADR-0050 wire types single source of truth
