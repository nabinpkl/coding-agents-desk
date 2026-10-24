# Crisp CPU: before/after damage-gating (ADR-0036)

Measured 2026-07-01 on the streaming host (sim client paired over localhost).

## The original complaint and the real cause

The reported "~100% CPU" was the **Debug** host. A `sample` showed
`OwnedTileCodec.extractTileWithHash` (the per-tile hash loop) saturating four
cooperative threads. Root cause: in `-Onone`, `observe()`'s per-byte
`for i in 0..<n` loops lower to `IndexingIterator` protocol-witness dispatch, a
10x+ multiplier. Building **Release** alone dropped the host to ~32% and
`extractTileWithHash` left the profile entirely (the optimized loop is cheap).

So the headline 100%→~30% fix was Debug→Release. Damage-gating is the *further*
optimization: it stops `observe()` re-hashing the whole surface every ~100ms
window, which matters most for Debug and for localized/static screens.

## Baseline (pre-gating)

- Debug host: ~101% CPU, `extractTileWithHash` the dominant leaf (4 threads pegged).
- Release host: ~32% CPU, `videotoolbox` (HEVC encode) dominant, `extractTileWithHash` already 0 samples. `observe()` unconditionally hashed the full surface (~290 tiles at 128px grid) every crisp window regardless of what changed.

## After gating (Release, sha 096517b)

Scenario: heavily-churning capture (the Claude Code TUI + terminal being
captured animate the whole screen constantly — the adversarial case for gating,
and the only one measurable from inside the captured session).

- Total host CPU ~40%, still `videotoolbox`-dominated (video encode tracks screen
  motion; gating does not touch it). `extractTileWithHash` = **0 samples**;
  whole `processCrisp` subtree ~31 of ~3000 samples (~1%). `extractBGRA` = 0.
- Gating is live and correct. Over a 12s window, of 67 emitting crisp windows:
  - **37 windows hashed 1-25 tiles** (localized gated passes — the win),
  - 1 window 26-100 tiles,
  - 29 windows 101+ tiles = the periodic ~1/s full-surface heal **plus** genuine
    full-screen-change damage (terminal scroll → damage covers the whole surface
    → hashing everything is correct).

Interpretation: when change is localized, a gated window now touches a handful of
tiles instead of ~290; when the whole screen changes, it correctly still hashes
everything; a heal reconciles ~1/s. In Release the crisp hash was already cheap
relative to video encode, so the total-CPU delta is modest; the structural win
(crisp work is now damage-proportional, and a settled screen early-outs before
the convert+hash) is confirmed by the window distribution and the flat
`processCrisp` profile.

## Caveat

A truly static-screen number could not be captured: the host captures the same
display the Claude Code agent UI animates on, so the capture never goes idle from
inside this session.

## A/B attribution (crisp ON vs OFF) — corrects the "video dominates" read above

Ran the host with crisp effectively disabled (`AGENTDESK_OWNED_MEDIA_CRISP_MIN_INTERVAL_MS`
huge, launched via `open` so ScreenCaptureKit TCC is preserved) vs normal, at
matched low activity (~1 video frame/s):

| Config | host %CPU | crisp windows |
| --- | --- | --- |
| crisp OFF | ~21% | 0 |
| crisp ON  | ~35% | ~35 / 10s |

So the constant CPU is roughly two halves, not one:

1. **~21% floor with crisp OFF** = the capture/video pipeline (ScreenCaptureKit
   running continuously + per-captured-frame drain/encode), present even when
   almost nothing is sent. Hardware HEVC encode itself is cheap (VideoToolbox/AVE
   ~40 samples); the floor is capture + per-frame handling, not the encoder.
2. **~14% added by crisp ON**, and its cost is the **full-frame YUV→BGRA convert**
   (`extractBGRA`, CIContext): CoreImage 356 samples, IOSurface/pixel-convert 514,
   while `extractTileWithHash` is **0 samples** and LZFSE only 37. The video ladder
   is at native scale (1.0), so the video downscaler CIContext is off — the CoreImage
   cost is the crisp convert.

Two consequences worth being honest about:

- The damage-gating landed here optimized the tile **hash** (0 samples in Release —
  already free) and added an early-out that only skips work on a **zero-damage**
  window. On any active screen (damage present) crisp still converts the **whole
  frame** every window, so the ~14% active-screen crisp cost is unchanged by gating.
  Gating's real wins are: a genuinely static screen now early-outs (skips convert +
  hash), and Debug builds (where the hash was the -Onone hot loop).
- The lever that would actually cut active-screen crisp CPU is the convert: convert
  only the damaged sub-regions to BGRA (not the full frame), or avoid the YUV→BGRA
  round-trip entirely. Cutting the ~21% floor is a separate lever (adaptive capture
  rate at rest, TeamViewer-style).

## The ~21% floor decomposed (crisp OFF, true leaf self-time)

79% of sampled frames are parked threads (idle: mach_msg / semaphore_timedwait /
__accept). The real on-CPU work (~2321 leaf samples over 6s) is spread thin, no
single hot loop, by module:

- libdispatch 14% — per-frame drain + datagram send scheduling overhead
- vImage 12% + CoreGraphics 9% — pixel-format convert + composite, mostly the
  desktop-strip thumbnails (vUnpremultiplyData_RGBA8888, Planar8→16, CGDataProvider)
- AgentDeskHost (our code) 7% — drainEncodeQueue, SpaceThumbnailProvider
  .captureAsync/composite/captureWindow, sendPacketsSerial/packetize, processCrispDamage
- kernel 7% (__sendmsg datagram send), CoreFoundation 7%, objc 5%, swift 4%,
  malloc 3%, Network 2%

The video HEVC encoder is hardware and barely registers (VideoToolbox/AVE minor).

### Correction: thumbnails were a sampling artifact, not the floor

`SpaceThumbnailProvider` captures on a 3s timer (bursty), so a point-in-time
`sample` catches a capture burst and overstates it. Verified by A/B with the new
`AGENTDESK_SPACE_THUMBNAILS_ENABLED=0` kill switch (0 captures confirmed in the
log): host CPU was ~36% with thumbnails OFF vs ~35% ON — **no meaningful change**.
So thumbnails are ~2-3% averaged, not the ~21% the single sample implied. The
kill switch is retained as a valid knob, but it does not move the constant CPU.

The constant costs, corrected:
- **crisp ~14%** — the full-frame YUV→BGRA convert (see the A/B section above). Real
  and sustained; the biggest single reducible chunk.
- **~21% floor (crisp off)** — the always-on datagram send path (packetize + pace +
  `__sendmsg` + Network) plus per-frame drain/dispatch overhead, running every
  captured frame. Not thumbnails, not the (hardware) encoder.

Levers, corrected: (1) crisp convert — convert only damaged sub-regions instead of
the whole frame; (2) the floor — batch datagram packetization / relax pacing
wakeups, and reduce per-frame drain overhead / capture rate at rest.

## Unit D landed: sub-region render into a fast malloc buffer (sha 964080c)

Lever (1) is now implemented. `processCrisp` renders **only the grid-aligned damage
bbox** (or the full frame on realloc) into a persistent `malloc` buffer via
`OwnedMediaCrispConvert.renderRegion`, then `reconcile` hashes tiles out of that
CPU-cached buffer. This replaced an interim IOSurface-backed attempt (call it
Unit C) that had made `reconcile` hash slow GPU memory — a net CPU wash. Unit D
reverts that and keeps the buffer in malloc.

Live-measured on a clean sim bring-up (host + client both Release, sim paired over
localhost), 8s `sample` on the adversarial churning-TUI screen (the same
whole-screen-animating case as above; a localized-change desktop would be far
cheaper and is where the real win shows):

- **Host CPU ~32% avg** (19-43% tracking activity) — back to the healthy pre-Unit-C
  Release baseline. Unit C's cost-relocation wash is gone.
- **Convert collapsed.** The pixel-convert leaf `vImageConvert_AnyToAny` is ~187
  samples vs the full-frame era's ~870 (CoreImage 356 + IOSurface 514). We now
  convert only the damaged bbox and skip the full-frame YUV→BGRA round-trip.
- **Hash is fast again.** `reconcile → OwnedTileCodec.extractTileWithHash` reads the
  malloc buffer (`base`), heaviest single-stack subtree ~210 samples — normal
  hashing, not Unit C's ~1026-sample slow-IOSurface blowup. No IOSurface reads
  under the hash.
- **VideoToolbox (HW HEVC) still dominates** the profile (~3343 samples on
  `videotoolbox.compressionQueue`) but is hardware-offloaded and tracks screen
  motion; crisp does not touch it.
- Thumbnails again showed as a bursty ~725-sample blip (3s capture timer caught
  mid-window), consistent with the "~2-3% averaged, not the floor" correction above.

Interpretation: on a churning full-screen the total-CPU delta from Unit D is modest
(the screen genuinely changes everywhere, so both the region and the hash are large),
but the structural win is real and measured — the convert no longer pays for the whole
frame, and the hash is off fast memory. On a localized-change desktop `renderRegion`
converts a small bbox and `reconcile` visits a handful of tiles, so both costs fall
proportionally; that case is not measurable from inside the captured animating session.

## Clean-gate crisp-OFF decomposition (sha 00d94e8, AGENTDESK_OWNED_MEDIA_CRISP_ENABLED=0)

Added a first-class `AGENTDESK_OWNED_MEDIA_CRISP_ENABLED` master flag (replaces the
min-interval hack). With it off, `processCrisp`/`processCrispDamage` are skipped at the
drain-loop call site (0 crisp windows confirmed in the log). Fresh sim bring-up, host +
client Release, 8s `sample` on the same churning-TUI screen.

- **Host CPU ~18% steady** (16.5-19.4%), vs crisp-on ~32% avg (19-43%, bouncy). So on
  this screen crisp adds ~14%, and it is the source of the variance (crisp cost tracks
  how much of the screen settled into hashable/convertible tiles).

Leaf self-time of the ~18% floor (on-CPU only; the 6354-frame threads are parked idle),
largest reducible chunks first:

1. **Video-encode surface feed ~1100** — `IOSurfaceAcceleratorTransformSurface` (892) +
   `IOSurfaceClientBindAccel` (201): the GPU transform of each capture IOSurface into the
   HEVC encoder's input format. The HW encode itself is offloaded (the big
   `videotoolbox.compressionQueue` / `coremedia.sharedRootQueue` thread totals are mostly
   AVE-blocked wait, not CPU). This is inherent to streaming video and scales with fps.
2. **Datagram send path ~800** — our `packetize`(44)/`enqueue`(81)/`send`(58)/
   `drainEncodeQueue`(84) + Network.framework socket writes (`nw_socket_service_writes` +
   `add_write_request` ~330) + libquic (`quic_conn_send_*` ~150) + kernel `__sendmsg`(75).
   Always-on, every frame. The biggest chunk we own outright and the top floor lever.
3. **Thumbnails ~1000 when bursting** — `SpaceThumbnailProvider.captureAsyncWithTimeout`
   (517) + `composite`(226) + the vImage/CGDataProvider convert under it (~300). Bursty on
   the 3s capture timer, so ~2-3% averaged (consistent with the A/B kill-switch result);
   the leaf cost is high only during a capture tick.
4. **CursorMonitor ~480 (steady)** — `CursorMonitor.tick`(483) + `hash`(44): a timer-driven
   cursor position/image poll with per-tick hashing. Not bursty; a steady, previously
   un-isolated slice of the floor. Candidate lever: slower poll or skip-hash when unchanged.
5. **Capture ingest ~300** — replayd XPC (239) + `scstream` queue (103) + our
   `ScreenCaptureKitFrameSource.stream(didOutput:)`(21) + `damageRects`(12). Cheap; our
   callback is a small part, most is ScreenCaptureKit's out-of-process plumbing.

Takeaways:
- The ~18% floor is NOT one thing. Ranked reducible levers: (a) the datagram send path
  (~800, ours) — batch packetization / relax pacing wakeups / lower cadence at rest;
  (b) CursorMonitor (~480, steady) — cheap to slow down; (c) thumbnails (bursty) — already
  have the kill switch. The video surface-feed (~1100) and HW encode are inherent to
  streaming and only fall with lower fps/resolution at rest.
- Crisp (~14% here) is now damage-proportional after Unit D; on a localized-change desktop
  both crisp and the video feed shrink, leaving the send path + cursor poll as the dominant
  at-rest floor.

## CursorMonitor seed-gating landed (sha 373c518)

The steady crisp-off floor's top *content-independent* eater was `CursorMonitor`: it
re-encoded the cursor to TIFF and SHA256-hashed it every 20Hz tick just to detect change.
Fixed by gating the fingerprint on the window-server cursor seed (`CGSCurrentCursorSeed`,
isolated behind `CursorChangeSignal`); the expensive path now runs only on a seed change
or a periodic heartbeat backstop.

Live-measured, crisp off, host+client Release, matched churning-TUI screen, 15s `sample`:

| Metric | Before | After |
| --- | --- | --- |
| `CursorMonitor` subtree (max inclusive samples) | 557 | 43 |
| `CursorMonitor.hash` self | 99 | 1 |
| `AccelerateCrypto_SHA256` self | 73 | 10 |
| `tiffRepresentation` (cursor image encode) | 280 | 8 |
| Host CPU% (steady) | ~17-24% | ~12-15% |

The seed read is below the sampling noise floor (zero frames) — the "one int read per tick"
goal. `tiffRepresentation` = 8 (not 0) confirms the mirror still re-fingerprints on real
cursor changes (the cursor changed a few times in the window), so it is cheaper, not frozen.
Regression is unit-locked by `constantSeedSkipsImageFingerprint` (static cursor ⇒ sampler
touched once over 100 ticks). ~5-8 points off the crisp-off floor.

## Lean floor: crisp OFF + thumbnails OFF + cursor-out-of-video (sha 57f051d)

Everything reducible disabled at once, to isolate the irreducible streaming floor:
`AGENTDESK_OWNED_MEDIA_CRISP_ENABLED=0`, `AGENTDESK_SPACE_THUMBNAILS_ENABLED=0`, and the
cursor no longer baked into video (new default) + the seed-gated CursorMonitor. Confirmed
live: 0 crisp windows, 0 thumbnail captures, streaming. 15s `sample`, host CPU ~13-20%
(~15.6% avg; the absolute number tracks screen motion / video bitrate on this churning TUI).

Leaf self-time probes (self-sum samples):
- CursorMonitor **0** (was 557 pre-seed-gate), SpaceThumbnail **0**, vImage **3** (was ~626,
  all thumbnails), processCrisp **0**, videotoolbox **0** (HW-offloaded), our AgentDeskHost
  code only **62** (~2%).

What remains IS the datagram send pipeline:
- `__sendmsg` 8.5% (the send syscall, top single leaf) + Network 5.5% + libquic 2.4% +
  `__recvmsg` -- the QUIC/socket send-receive machinery.
- CoreFoundation 14.5% + libswiftCore 12.8% + libobjc 10.6% + libdispatch 8.3% + malloc 6.1%
  -- the per-packet/per-frame object churn of packetize -> pace -> send (objc_msgSend,
  CFDictionary get/set + CFBasicHashFindBucket, ARC, malloc/free, dispatch drain).

Conclusion: after removing crisp (convert), thumbnails (vImage composite), and cursor (per-
tick hash + baked-in video damage), the floor is the cost of PUSHING ~2 Mbps of video
datagrams at 25-30 fps, not producing them -- video encode is hardware, our code is ~2%.
The only remaining lever is send-path efficiency: batch more packets per `__sendmsg`, cut
per-packet allocation/dictionary churn, or lower send cadence/bitrate at rest. This is
inherent-to-streaming work, a different (harder) class than the add-ons already removed.
