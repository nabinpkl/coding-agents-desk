---
status: proposed
date: 2026-05-23
---

# Native-pixel encoder density, local-only zoom

## Context and Problem Statement

ADR-0007 picked host-side `SCStream.sourceRect` crop on pinch-end with active prefill on pinch-start, on the theory that cropping the captured region would push more output pixels per source pixel during zoom and surface readable text. Live integration showed two flaws the ADR did not anticipate. First, every `updateConfiguration` call forces an IDR keyframe and changes the encoded frame's source region, so the iPhone's UIScrollView, mid-zoom and still holding the old transform, snaps to a different visible region the moment the new frame arrives. Second, the baseline full-display stream was already being encoded at point density rather than pixel density: `SCStreamConfiguration.width` and `.height` are pixels by API contract, but the existing code assigned `display.width` and `display.height`, which `SCDisplay` documents as points. On Retina that meant every frame was downsampled to half resolution at capture, leaving the whole picture soft regardless of crop.

The user feedback after R21 Path B landed was that zoom felt "step by step its not smooth and its autolayouting on zoom". The "step by step" is the keyframe + content-snap that fires on each pinch settle; "autolayouting on zoom" is the iPhone's visible region effectively shifting because the underlying frame's source region changed under the local zoom.

Affected modules: `host/AgentDeskHost/ScreenCaptureKitFrameSource.swift`, `host/AgentDeskHost/VideoFrameSource.swift`, both `SharedTypes.swift`, `host/AgentDeskHost/AppDelegate.swift`, `client/AgentDeskClient/PairingViewController.swift`.

## Decision Drivers

- Zoom feel matters more than peak per-source-pixel density. A smooth interaction with consistent sharpness beats an interaction that lurches into a sharper region.
- The points-vs-pixels mismatch was an unobserved bug; fixing it lifts the baseline image regardless of any zoom strategy.
- `SCStream.updateConfiguration` is expensive (IDR + source-rect handoff) and shows visibly on a 30 Hz stream when fired at gesture cadence.
- Wire shape minimalism. The `viewport` field on `ClientConfig` was added for the crop path. If we are not using it, it is dead surface.

## Considered Options

- **Option A: keep host crop, fix the points-vs-pixels math.** Encoder at native pixels, sub-rect still cropped on pinch. Same step-by-step interaction model with sharper baseline; the visible content snap is unchanged.
- **Option B: keep host crop, atomically reset local zoom on viewport apply.** When sending viewport the client immediately sets `zoomScale = 1.0`. Removes the lurch but adds a brief "zoom-out flash" during the 100 ms handoff. Does not help pinch-out.
- **Option C: drop the host-side crop, bump encoder to native pixels, keep local UIScrollView zoom.** No `updateConfiguration` mid-gesture, no source-region snap, baseline sharpness lifts from points to pixels. Local zoom up to 4x stays sharp because the source frame is already 4x denser on Retina than the v0 baseline was.
- **Option D: drop both host crop and local zoom.** Loses the feature.

## Decision Outcome

Chose **Option C**.

The host stream encodes at native pixel density (`config.width = display.width * backingScale`, same for height). Backing scale is read from `NSScreen.backingScaleFactor` matched by `displayID`, defaulting to 2.0 when no screen matches (multi-monitor edge case). Local UIScrollView zoom remains as the only zoom mechanism. No client-config viewport field, no `SCStream.updateConfiguration` calls outside the original `start` configuration.

Pinch interaction is now purely UIScrollView's transform, which is OS-handled and frame-rate-bound only by Core Animation. The iPhone never sees its source region change mid-gesture, so the visible content does not snap.

### Consequences

- Good, because pinch feels smooth: no keyframes, no source-region handoffs, just UIScrollView transform scaling.
- Good, because the points-vs-pixels fix lifts baseline image quality across the whole experience, not only when zoomed.
- Good, because the wire shape is smaller: `ClientConfig` no longer carries a `viewport`, `VideoFrameSource` no longer has a `RegionalVideoFrameSource` sibling.
- Bad, because the encoder now handles 4x more pixels per frame on Retina at the same bitrate cap (currently 8 Mbps maxBitrateKbps). Static UI text encodes well at low bits/pixel with VP9 screencast; high-motion content (video playback inside the captured display) will degrade more visibly than it did at point density. Acceptable for a daily-driver agent-control surface; revisitable if motion content becomes a daily-driver workload.
- Bad, because past ~4x local zoom the user will see source-pixel blockiness. The previous design's promise of "8x effective via 2x local + 4x crop" is gone. 4x is enough for the daily-driver readability target; deeper inspection is a v1 follow-up.
- Neutral, because the `setSourceRect` API is gone but nothing consumed it externally; ADR-0007's wire shape is fully reverted with no callers.

### Confirmation

- Live integration verifies sharpness at the new encoder dimensions; the host log line `screen capture started <WxH> scale=<f>` exposes the chosen values.
- The existing `screen capture started` smoke path covers the new dimensions; the backing-scale fallback path is exercised by unplugging an external monitor mid-session (manual).
- Manual UX check: pinch in to ~3x with smooth continuous motion; release; release should produce no perceptible content snap. The picture should be readably sharp throughout, not only after release.

## Pros and Cons of the Options

### Option C (chosen)

- Good, because eliminates the keyframe-on-gesture failure mode entirely.
- Good, because addresses the points-vs-pixels bug as part of the same change.
- Bad, because trades peak achievable sharpness for consistency; deep zoom past 4x is now blockier than the previous design's theoretical ceiling.

### Option A

- Good, because retains the design ambition of "infinite zoom via host crop".
- Bad, because the step-by-step interaction is the actual user pain; fixing the bitrate doesn't fix the lurch.

### Option B

- Good, because preserves the host crop while removing the lurch.
- Bad, because the 100 ms zoom-out flash is also visible jank, and pinch-out (cropped to wider) still requires a host round-trip.

### Option D

- Good, because simplest possible behavior.
- Bad, because loses the zoom feature, which is real value for agent users inspecting text.

## Links

- ADR-0001 v0 stack and transport.
- ADR-0004 media transport seams.
- ADR-0007 host-side viewport crop, superseded by this ADR. The wire shape (`ClientConfig.viewport`, `ViewportRect`) and protocol (`RegionalVideoFrameSource`) added there are removed here; `SCStream.sourceRect` is no longer touched after stream start.
- Apple developer docs for `SCStreamConfiguration` width/height pixel-density contract.
- Apple developer docs for `NSScreen.backingScaleFactor`.
