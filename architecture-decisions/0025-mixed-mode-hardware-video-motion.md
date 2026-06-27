---
status: accepted
date: 2026-06-25
supersedes: ADR-0024 (predict-and-correct scroll), and the scroll bet of ADR-0022
superseded-by:
---

# Mixed-mode renderer: hardware HEVC video for motion, retained tiles for rest

## Context and Problem Statement

Three iterations tried to carry scrolling motion on the retained-tile substrate and the device rejected all three. ADR-0022 bet tiles plus progressive repaint would carry scroll; ADR-0023 revived a verify-or-fallback copyRect (2 of 76 declared scrolls accepted on device); ADR-0024 replaced the verify gate with a hash-based predict-and-correct proposer (0 of 138 accepted on a physical iPhone, every scroll collapsing to a 90 to 145 KB whole-band re-tile, a multi-second stall at the ~2 Mbps link). The failure is not a tuning miss; it is the substrate. This touches the host owned-media encode path (`OwnedMediaTransport`, `ScrollDeltaEngine`), the wire (`SharedTypes` owned-media frame and control types), the QUIC transport on both ends, and the client compositor (`OwnedMediaVideoSink`).

Measured against the screen-content-coding literature (HEVC-SCC, the Microsoft hash-based-motion-estimation patent US 11,095,877, RDP mixed-mode graphics), our model copied the *shape* of motion estimation but not its *substance*, and every choice was the opposite of what production systems make:

| Concern | Our retired model | RDP / HEVC-SCC | Why ours failed on a device |
| --- | --- | --- | --- |
| Match unit | full-width exact-hash rows | small spatially-constrained blocks | one differing pixel (scrollbar, cursor, caret, anti-aliased edge) kills a whole row's vote |
| Imperfect match | rejected, whole-band re-tile | cheap quantized residual | a Retina scroll re-rasterizes at sub-pixel phase, so the exact match never holds |
| Residual granularity | binary per-128px-cell | graded per-pixel quantized | no way to send "almost the same, here is the small difference" |
| Motion carrier | hand-rolled copyRect plus exact tiles | a real video codec (block ME + quantized residual + skip + intra-refresh, in hardware) | we rebuilt a codec badly instead of using the one in silicon |

Every one of those gates on an exactness real screen content never has.

## Decision Drivers

- Scrolling is the daily-driver motion and must be cheap and smooth on real Retina content, not only on synthetic pixel-exact translations.
- Text at rest must stay pixel-perfect; a lossy video pass over static text is a regression.
- The link is thin (~2 Mbps); the motion carrier must hold a readable floor well under that.
- No exactness gate anywhere in the motion path; the carrier must degrade gracefully under loss, not stall.

## Considered Options

- **Option A**: a better proposer on the tile substrate (smaller blocks, graded residual) built by hand.
- **Option B**: full-surface hardware HEVC for motion, retained tiles for rest, routed by the input-declared motion state (RDP mixed-mode).
- **Option C**: video for everything, dropping the tile path entirely.

## Decision Outcome

Chose **Option B**. Option A loses because it rebuilds, by hand and in software, the block motion estimation plus quantized residual plus skip that VideoToolbox already does in hardware; three device iterations show the hand-rolled path cannot reach the readable floor on real content. Option C loses because a lossy video pass over static text gives up the pixel-perfect rest state that the retained-tile cache (the surviving, proven half of ADR-0022) already delivers for free. So: rest keeps the tile path unchanged; a declared scroll plays as full-surface, inter-predicted hardware HEVC; the input-declared motion state (`MotionGovernor`, fed by `ScrollActivityTracker`; the phone causes every scroll) routes between them.

Full-surface video, not a sub-region: HEVC skip makes the static area near-free, and it removes all video-over-tile compositing and coordinate alignment. The stream rides **QUIC datagrams**, not the reliable graphics stream, because ADR-0022's residual freeze was head-of-line blocking of large frames on the one reliable stream; real-time video must tolerate loss and recover by intra-refresh, which datagrams plus periodic keyframes plus a client keyframe-request give. The reliable graphics stream stays for tiles, exactly as the two carriers coexisted before ADR-0022. The client decodes by display with `AVSampleBufferDisplayLayer` (display-immediately) rather than a hand-rolled `VTDecompressionSession`.

The one coherence-sensitive seam is scroll -> rest. The video's last frame and the first crisp tile show the same pixels, so the swap is a quality sharpen, not a content jump. The client holds the video visible until the host's post-motion full-surface tile refresh has been applied, then reveals tiles; this avoids both a black gap and a stale jump.

### Consequences

- Good, because a declared scroll plays as a hardware HEVC stream at the readable floor (target well under 2 Mbps, skip handles the static background) instead of a 90 to 145 KB whole-band re-tile, and the cursor is carried correctly during motion for free.
- Good, because rest stays pixel-perfect: the retained-tile cache and progressive repaint are untouched.
- Bad, because datagram loss during scroll can glitch until the next keyframe; bounded by frame-repair plus keyframe-request, and the motion-stop tile refresh scrubs any residue.
- Neutral, because the pipeline now runs two carriers again (reliable tiles plus datagram video), the same shape it had before ADR-0022; the complexity is paid back by deleting the hand-rolled scroll machinery.

### Confirmation

Host and client unit tests cover each revived unit: encoder keyframe/delta cadence and force-keyframe; datagram packetize/decode, fragmentation, MAC rejection; the client repair buffer's reassembly, resend-request, and deadline-expiry paths; the resend ring; the decode-by-display drop-pending-keyframe gate; and the handoff swap state machine's "do not reveal tiles until the post-motion refresh commits" rule. Device confirmation: over `com.example.agentdesk.AgentDeskHost` `owned-media`, a declared scroll plays as a smooth HEVC stream well under 2 Mbps (not `tiles-scroll-miss` at 90 to 145 KB); motion-stop sharpens to crisp tiles with no black gap and no stale jump; no multi-second head-of-line freeze.

## Pros and Cons of the Options

### Option A (better hand-rolled proposer on tiles)

- Good, because it keeps one carrier and one substrate.
- Bad, because it is the third attempt at the thing three device sessions already disproved; it rebuilds a hardware codec in software and still gates on an exactness real content lacks.

### Option B (mixed-mode: video for motion, tiles for rest)

- Good, because it uses the hardware codec for what it is built for and keeps the proven tile path for pixel-perfect rest.
- Good, because it is RDP's shipped model, routed by a motion truth we already hold.
- Bad, because it reintroduces a second carrier and a handoff seam to keep coherent.

### Option C (video for everything)

- Good, because it is the simplest single-carrier design.
- Bad, because a lossy video pass over static text regresses the pixel-perfect rest state the tile cache already delivers.

## Links

- SPEC: owned-media transport and the `ScrollDeltaEngine` / wire notes
- ADR-0022 (multi-stream QUIC and progressive repaint): its multi-stream and tile/cache halves stand; its scroll bet is superseded here
- ADR-0023 (revive hardened scroll copyRect): superseded
- ADR-0024 (predict-and-correct scroll): superseded
- HEVC-SCC; Microsoft hash-based motion-estimation patent US 11,095,877 (issued 2021-08-17); RDP mixed-mode graphics
