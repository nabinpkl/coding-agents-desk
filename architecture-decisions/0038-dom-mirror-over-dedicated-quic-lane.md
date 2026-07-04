---
status: proposed
date: 2026-07-01
---

# Mirror Chrome DOM over a dedicated reliable QUIC lane instead of pixels

## Context and Problem Statement

The owned-media path streams the Mac screen as pixels (video datagrams + a crisp-tile graphics lane, ADR-0034/0036). Pixels are the wrong representation for text-heavy Chrome pages: small type is exactly where lossy video and even the crisp overlay struggle, and it costs bandwidth to re-encode text that never changes. A spike (`spikes/rrweb-dom-mirror/`) showed that shipping the page's DOM with rrweb instead gives vector-crisp text at ~16 KB for a full snapshot and near-zero idle bandwidth, with late-join via periodic checkout. This decision introduces a Chrome-DOM-mirroring subsystem alongside (never entangled with) the media path, touching `SignalingChannel.swift` (stream roles), a new host `DomEventLaneServer`, a new client `DomMirrorSurface`, and the MV3 extension + native bridge (see ADR-0039).

## Decision Drivers

- Crisp, legible text on the phone regardless of network, where the pixel path is weakest.
- Keep the new path decoupled from the media/video pipeline; no shared mutable state, no regressions to the shipping video floor.
- Reuse the existing reliable-lane machinery (`GraphicsLaneServer`) and wire conventions rather than inventing transport.
- A late-joining phone (freshly paired) must reach a coherent frame without replaying from session start.
- Ship value incrementally and safely: read-only mirror first, behind a default-off flag.

## Considered Options

- **Option A**: Dedicated reliable QUIC stream role (`.dom = 4`) carrying checkout-framed rrweb events, parallel to the graphics lane.
- **Option B**: Reuse the existing `.graphics` lane, multiplexing DOM events with crisp tiles.
- **Option C**: Push DOM events over the `.input` lane alongside DesktopState/cursor pushes.

## Decision Outcome

Chose **Option A** because the decoupling driver knocks out B and C: the graphics lane is owned by the crisp-tile pipeline and multiplexing DOM batches into it would couple two independent subsystems and let a large DOM snapshot head-of-line-block crisp tiles; the input lane is a low-rate control/telemetry channel and bulk DOM traffic would contend with input latency. A dedicated `.dom` role reuses `QuicSessionStreamFrame` framing and the `GraphicsLaneServer` open/own/push pattern while keeping the DOM subsystem in its own lane, its own server, and its own late-join buffer. The lane is gated by both `SessionInit.protocolVersion` and `Config.domMirrorEnabled` (default false), so existing clients and un-flagged builds never see it.

### Consequences

- Good, because text renders as real DOM in the client's own browser engine: sharp at any bandwidth, near-zero idle cost.
- Good, because the media path is untouched; the DOM lane can be developed, flagged, and reverted independently.
- Bad, because it adds a whole new cross-process subsystem (extension, native bridge, host lane, client surface) with its own failure modes and a privacy surface (real DOM text) that must be masked.
- Neutral, because non-DOM surfaces (canvas/WebGL/video, cross-origin iframes) are not representable and must fall back to the pixel path (deferred to Phase 6).

### Confirmation

`streamRoleBytesArePinned` and `quicSessionFrameRoundTripsDomRole` pin `.dom = 4` and its framing; `domBatchEnvelope*` tests pin the wire envelope. The autonomous `just dom-mirror-e2e` recipe asserts a sim client reconstructs a fixture's sentinel text and bootstraps late-join from the checkout. `Config.domMirrorEnabled` defaults false, verified by unit test.

## Links

- ADR-0034 motion-region crisp repair (the reliable graphics lane this parallels)
- ADR-0036 crisp damage-gated observe
- ADR-0039 native-messaging bridge with a sacrificial shim
- `spikes/rrweb-dom-mirror/` — the proof-of-concept this subsystem replaces
- rrweb — https://github.com/rrweb-io/rrweb
