---
status: proposed
date: 2026-06-25
supersedes: ADR-0021 (damage-driven retained graphics)
---

# Multi-stream QUIC and progressive repaint, dropping pixel-guessed scroll

## Context and Problem Statement

ADR-0021 kept two bets from the scroll-first lineage: consume the OS damage signal (`SCStreamFrameInfoDirtyRects`) to drive tiles, and reconstruct a scroll offset from pixels to drive an on-screen `copyRect`. Device measurement on the current build (workstreams A through D landed) shows the first bet pays and the second does not. Over a 3425-frame session: the content-addressed tile cache served `cacheHit=3662`, while `copyRect` fired on 33 frames, about 1 percent. The residual freeze is no longer a reset cascade (generation topped at 3, was 7) but a single large tile repaint: frames are capped near 266 KB, and on the one reliable in-order QUIC stream a 266 KB frame drains in about 1.04s at the ~256 KB/s link, which is the observed "1 to 2 second" stall. The pacer engaged hard (`rate-cap=570`) and the client never backlogged (`queuedFrames` peaked at 1), so the stall is head-of-line blocking on the shared stream, not client decode.

Research into why `copyRect` will not fire is decisive. RDP and VNC never reverse-engineer scroll from pixels: Windows hands the encoder explicit move rects (`DXGI_OUTDUPL_MOVE_RECT`, or historically GDI `BitBlt`/`ScrollDC` intercepts emitting `SCRBLT`), and X11 VNC gets `CopyRect` from `XCopyArea`. macOS once exposed the same hint (`CGDisplayStreamUpdate` `kCGDisplayStreamUpdateMovedRects` plus `movedRectsDelta`), but Apple obsoleted `CGDisplayStream` in macOS 15 and ScreenCaptureKit, its only replacement, folds moved content into the generic dirty-rect array with no move vector. So the offset our estimator hunts is a signal the OS used to provide and now withholds. Reconstructing it from pixels is the fragile path no production system takes.

This decision touches the host scroll stack (`ScrollOffsetEstimator`, `FrameComposer`, the `makeScrollEnvelope`/`.scroll` path and `copyRect` command in `ScrollDeltaEngine`), the per-frame wire ceiling from workstream D (`makeTileEnvelope`, `hybridFrameWireCeilingBytes`, `hybridFrameScaleFloor`), the client `copyRect` handler in `OwnedMediaVideoSink`, the `copyRect` wire case in both `SharedTypes`, and the QUIC transport in `OwnedMediaTransport` (host and client).

## Decision Drivers

- The ~1s scroll freeze must be removed at its cause (one big frame monopolizing one ordered stream), not capped by shrinking the frame.
- Stop reconstructing a signal the OS does not provide. Detection and routing should rely only on OS-given damage (`dirtyRects`) and input-truth motion state, never on pixel-guessed offsets.
- Keep text crisp. The no-video-codec stance (ADR lineage) stands, so the answer cannot be "degrade to a video codec whose motion vectors make scroll free."
- Keep the parts the device proves work: the content-addressed tile cache and the damage-driven tile ladder.
- Reduce the fragile-knob surface. The estimator, its verify floor, and the geometry gates are tuning load nobody can make fire.
- The interactive path (cursor, input acks, small dirty rects) must never wait behind a large repaint.

## Considered Options

- **Option A, keep tuning the estimator and the D ceiling**: lower the verify floor, densify sampling, keep shrinking frames to fit a byte ceiling.
- **Option B, switch to a video codec**: let inter-frame motion estimation absorb scroll, accept lossy text.
- **Option C, drop pixel-guessed scroll, move the fix to the transport**: delete the estimator and `copyRect`, keep damage-driven tiles plus the content cache, split graphics and interactive traffic onto independent QUIC streams, and replace the per-frame shrink ceiling with progressive coarse-to-fine repaint that supersedes itself when new content arrives.
- **Option D, ground-up rewrite**: redesign capture, caching, transport, and compositor together.

## Decision Outcome

Chose **Option C**. The freeze is a transport problem (one ordered stream shared by a 266 KB repaint and the interactive updates behind it), and we were attacking it at the frame-encoding layer. Option A was rejected because the offset it tunes is an OS signal macOS no longer emits, so 1 percent is a structural ceiling not a calibration target, and the byte ceiling is a documented dead end that discards quality while still shipping one monolithic head-of-line-blocking frame. Option B was rejected by the crisp-text driver and the standing no-video ADR. Option D was rejected because it re-proves capture, cache, and compositor that the device shows already work, for no additional root-cause coverage.

The realignment has three moves.

**Delete pixel-guessed scroll.** Remove `ScrollOffsetEstimator` and its tests, the `makeScrollEnvelope` builder and the `.scroll` branch in `ScrollDeltaEngine`, the `copyRect` wire command in both `SharedTypes`, and the client `copyRect` blit handler in `OwnedMediaVideoSink`. `FrameComposer` keeps the input-declared `MotionSignal` but no longer measures an offset; a declared scroll routes to the damage-driven tile ladder like any other damage. The retired knobs are `hybridScrollOffsetVerifyFloor` and the classifier geometry gates. `MotionSignal {rest|scrolling}`, `ScrollActivityTracker`, `MotionGovernor`, and `TileContentCache` stay; they are input-truth or content-addressed and never depended on the offset.

**Split the QUIC connection into independent streams.** Network.framework supports this natively since iOS 15 and macOS 12: an `NWConnectionGroup` built from `NWMultiplexGroup(to:)` is the QUIC connection, and each `NWConnection(from: group)` is a separate stream under it, accepted on the server via `newConnectionGroupHandler` then `group.newConnectionHandler`. Move graphics frames onto a graphics stream and cursor, input acks, control, and small dirty-rect updates onto an interactive stream. QUIC streams are independently flow-controlled, so a large graphics send no longer head-of-line-blocks the interactive stream. Network.framework exposes no per-stream priority, so relative pacing stays application-managed; the existing send pacer (workstream A) becomes the graphics-stream pacer, and the interactive stream is left unpaced and small.

**Replace the shrink ceiling with progressive repaint.** Instead of forcing a large repaint down to `hybridFrameScaleFloor` to fit one frame (workstream D), encode a large damage region coarse first for immediate legibility, then refine in later paced sends on the graphics stream, and cancel an in-flight refinement when newer content supersedes the region (the RemoteFX Progressive Codec pattern). The content cache still suppresses re-exposed tiles on scroll-back; progressive repaint covers the irreducible case the cache cannot, namely new content scrolling in, which is genuinely new bytes that must degrade gracefully rather than freeze. Workstream D's ceiling and floor knobs and `FrameByteBudgetTests` retire with this move; A (pacer, byte cap), B (velocity strip downscale, now applied to fast tiles), and C (reset robustness) stay.

This is a breaking wire change (the `copyRect` command leaves the enum, stream framing changes). Pre-v0 that is free; host and client update together and local state is wiped externally with no migration scaffolding.

### Consequences

- Good, because a large repaint can no longer stall the cursor or input: independent QUIC streams remove the shared head-of-line by construction, which is the exact failure the device showed.
- Good, because the fragile subsystem leaves the tree: no phase-correlation estimator, no verify floor, no geometry gates, no `copyRect` path host or client.
- Good, because the OS-aligned parts that the device proves (damage-driven tiles, content cache at 3662 hits) are kept and now carry all scroll, not a 1-percent special case.
- Good, because progressive coarse-to-fine makes a big repaint readable immediately and crisp shortly after, instead of frozen then crisp.
- Bad, because the transport blast radius is larger than a host-only change: `NWConnection` becomes `NWConnectionGroup` on both sides, streams must be tagged and demuxed, and the listener accept path changes.
- Bad, because progressive repaint adds host encoder state (per-region refinement passes and a supersede-and-cancel rule) that did not exist before.
- Bad, because losing `copyRect` gives up the theoretical best case of near-free scroll over static content; the device shows that case was already unreachable on macOS, so the loss is theoretical not measured.
- Neutral, because Network.framework offers no per-stream priority, so pacing stays an application concern; the existing pacer already fills that role.

### Confirmation

This decision is followed when:

- `ScrollOffsetEstimator`, `makeScrollEnvelope`, the `.scroll` branch, and the `copyRect` wire case are deleted host and client, and `grep` finds no `copyRect`/offset-estimator references in the live path.
- The transport opens at least two QUIC streams on one connection via `NWConnectionGroup`/`NWMultiplexGroup`, and a host-side test shows a large graphics send does not delay an interactive-stream message.
- A large repaint is delivered as a coarse pass followed by refinement, and a superseding repaint cancels the pending refinement rather than completing it.
- On `just iphone-console-run-dev`, a hard flick shows no multi-second stall, cursor and input stay responsive during the repaint, `cacheHit` stays high, and there is no generation-reset cascade.
- Workstream D's ceiling and floor knobs and `FrameByteBudgetTests` are gone, and `MotionGovernor`, `TileContentCache`, and the A/B/C flow-control survive with tests green.

## Pros and Cons of the Options

### Option A, keep tuning the estimator and the D ceiling

- Good, because it is host-only and changes no wire or transport.
- Bad, because the offset it tunes is an OS move-vector macOS 15 no longer emits, so the 1-percent fire rate is structural; and the byte ceiling discards quality while still head-of-line-blocking one frame.

### Option B, switch to a video codec

- Good, because inter-frame motion estimation makes scroll cheap with no OS hint, and cadence stays smooth.
- Bad, because lossy inter-frame coding degrades text at ~2 Mbps, which the crisp-text driver and the no-video ADR forbid.

### Option C, drop pixel-guessed scroll, move the fix to the transport

- Good, because it removes the freeze at its cause, deletes the fragile subsystem, and keeps the OS-aligned cache and tile ladder.
- Bad, because the transport change spans host and client, and progressive repaint adds encoder state.

### Option D, ground-up rewrite

- Good, because it could co-design capture, cache, transport, and compositor.
- Bad, because it re-proves working parts for no extra root-cause coverage.

## Links

- ADR-0021 damage-driven retained graphics, the decision this supersedes (its tile/cache half is kept, its `copyRect`/offset half is dropped).
- ADR-0016 scroll-first hybrid retained graphics, superseded transitively.
- ADR-0014 QUIC datagram owned media and ADR-0013 single-surface UDP, the transport lineage that collapsed to one reliable stream; this ADR re-expands it to multiple reliable streams.
- ADR-0005 input channel separation, the existing separate input channel that this complements at the QUIC-stream layer.
- Apple, multiple QUIC streams via `NWMultiplexGroup`/`NWConnectionGroup`, public since iOS 15 / macOS 12: https://developer.apple.com/documentation/network/nwmultiplexgroup and WWDC21 session 10094 (2021).
- Apple, ScreenCaptureKit `SCStreamFrameInfoDirtyRects` gives dirty rects but no move vector: https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects (no date verifiable).
- Apple, `CGDisplayStreamUpdate` moved-rects API, obsoleted in macOS 15: https://developer.apple.com/documentation/coregraphics/cgdisplaystream (no date verifiable).
- Microsoft, `DXGI_OUTDUPL_MOVE_RECT`, the OS-provided move rect RDP relies on: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_outdupl_move_rect (no date verifiable).
- Microsoft, MS-RDPEGFX RemoteFX Progressive Codec, coarse-to-fine with cancel-on-supersede: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/1dcd953d-672b-457e-9dec-a6fe639bae8f (2025-08-11).
- RFC 9000 QUIC, per-stream flow control and head-of-line isolation: https://www.rfc-editor.org/rfc/rfc9000.html (2021-05).
