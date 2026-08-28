# Handover: Desktop park live tiles

Written 2026-08-25. Branch `main`, HEAD `b241d3fa`, everything committed and pushed.

Runtime update, 2026-08-28: the build-path instructions below are historical. ADR-0113 installs
the helper with `just grid-encoder-install` into the durable Application Support runtime; compiling
to `.build` alone no longer updates it. Host launch recipes likewise use an installed app copy.
Read the current `AGENTS.md` runtime section and `TASKS.md` D277/R278 before deployment.

Read `AGENTS.md` first for how to work in this repo. This file covers only the
arc that just happened and what it left behind. Previous handovers are preserved
in this file's git history; the one before this is `55155019` (2026-08-01,
quality ladder R231 and the R230 black screen), and section "Still open from the
previous handover" below carries forward the part of it that is not done.

## Where this stands

Desktop park can show a live window, or the whole active Space, as video inside
the Agent Panel, on the Mac and on the iPhone, over the tailnet including LTE.
Two delivery paths exist behind a per-tile toggle: **WebRTC** (default, better)
and **fMP4 over HTTP into MSE** (the first one built, kept as the A/B control).
The tile has a map-style viewport (pinch, pan, double-tap) and a
pseudo-fullscreen mode.

The arc's thesis, which held: **WebRTC as transport only.** Our own hardware
encoder on one end, the webview's built-in hardware decoder on the other, and
the transport in between owning every timing decision. ADR-0001's libwebrtc was
encoder *and* transport *and* renderer and lost on software codecs; that verdict
never tested this shape, and it does not apply to it.

## The one thing waiting on a human

**A client install has been prepared and NOT run.** Per `AGENTS.md`, device
installs are a checkpoint: state the command, then wait for the user to say run
it.

```bash
just client-install
```

Why it cannot be avoided: commit `b241d3fa` sets
`WKWebViewConfiguration.allowsInlineMediaPlayback`, which defaults to `false` on
iPhone (`true` on iPad). A page's `playsinline` attribute is honored only if the
container already permits inline playback, so without this the iPhone hands any
playing tile to the system fullscreen player and the gesture overlay, pan/zoom
and tile chrome all vanish. This is the **only** native change in the whole arc;
everything else is live-reloadable TypeScript.

Unverified claim to test with that install: that this flag was the cause. The
symptom ("goes fullscreen the moment it connects") is that flag's exact
signature, but if it persists afterwards, suspect the client constructing its
own `WKWebView` for the agent surface outside `WebPanelKit`.

## What exists now

**Encoder** `tools/grid-encoder/main.swift`, built by
`tools/build-grid-encoder.sh` to `.build/grid-encoder`. ScreenCaptureKit in,
VideoToolbox hardware encode out. Makes no policy decisions.

- Target: `--window <id>` or `--display <id|main>`.
- Output mode: `--codec hevc-fmp4` (default, fragmented MP4 for MSE) or
  `--codec h264-annexb` (bare access units for a transport that packetizes).
- `--profile high|main|cb` (annexb only, default high).
- stdout framing `[1 byte kind][4 bytes BE length][payload]`; kind 0 meta JSON,
  1 fMP4 init, 2 fMP4 media, 3 access unit (8 bytes pts microseconds BE, 1
  keyframe byte, then Annex-B).
- **stdin line protocol**: `K\n` forces a keyframe on the next frame,
  `B<bits>\n` applies a bitrate live. That is the entire encoder control
  surface, and it mirrors libwebrtc's own internal encoder callbacks.
- Cursor is drawn for display captures, not window captures.
- Self-reaping: exits if a stdout write stalls past 10s (reader gone), and if
  zero frames are submitted within 10s of `startCapture` (wedged stream).

**Sidecar** `agent-feed/sidecar/src/http/`

- `webrtcTileRoutes.ts` — `POST /api/park/tile/:target/webrtc`, target is a
  window id or the literal `display`. Owns offer/answer, negotiated-codec
  selection, the shared per-target encoder pool, PLI and REMB relay to the
  encoder's stdin. Writes connection diagnostics to
  `/tmp/agentdesk-webrtc-diag.log`.
- `h264Packetizer.ts` — RFC 6184 mode 1. Pure reframing, tested. Exists only
  because werift ships the depacketizer and not the packetizer.
- `tileRoutes.ts` + `tileEncoderPool.ts` — the MSE path, `GET
  /api/park/tile/:target/stream`.

**Panel** `packages/AgentPanel/Web/src/features/desktop-park/`

- `TileStreamRtc.tsx` — offer/answer POST plus `srcObject`. That is all.
- `TileStream.tsx` — the MSE feed loop, which needs a live-edge chase, buffer
  pruning and a reconnect policy. Keep it around as the honest comparison of
  what a byte-hose transport costs.
- `TileViewport.tsx` + `tileViewportMath.ts` — gesture ownership and pan/zoom
  as one CSS transform. `toContentPoint()` is the exported inverse and is
  deliberately the hook remote control will use.
- `DesktopParkModal.tsx` — watch a window or the desktop, transport toggle,
  pseudo-fullscreen toggle.

**The seam ledger.** What we write: the packetizer, offer/answer, post-
negotiation profile selection, two stdin control lines, the viewport. What we
glue with zero decisions of ours: capture, hardware encode, ICE, DTLS, SRTP,
NACK retransmit, jitter buffering, late-frame dropping, bandwidth estimation,
hardware decode, compositing. There are **no frame acks anywhere**; the receiver
speaks only in standard RTCP.

## Traps that cost real time, all measured

- **Two ScreenCaptureKit captures of one window starve each other.** Seen three
  times in three costumes: React strict mode's 48ms double-fetch; a reconnect
  overlapping the dead peer's encoder (which outlives it by the ICE consent
  timeout); and a manual encoder bounce racing its own replacement. **A starved
  SCK stream never recovers while its process lives** (observed wedged at 0% CPU
  for 8 minutes). Hence one encoder per target, keyed by target alone, plus the
  zero-frame watchdog.
- **The receiver enforces the profile of the payload type it receives.** High
  bits on a Baseline payload type decode **zero** frames. werift negotiates by
  mimeType only and defaults the sender to the browser's *first* H264 entry
  (Baseline), so the route picks the browser's own High entry (`64`/`f4`,
  `packetization-mode=1`) after the answer and encodes to match. "SDP is
  advisory" was measured false.
- **Do not negotiate transport-wide-cc for screen content.** werift's
  sender-side estimator assumes a saturating sender: 191 TWCC feedbacks in, zero
  estimates out on a static window. Without the extension the browser falls back
  to REMB, its own receiver-side estimator, which hands us a number directly on
  `sender.onRtcp` as `feedback.bitrate` (bigint).
- **Never carry MSE's GOP into RTP.** A 0.4s keyframe cadence was a segment
  container constraint; at tile bitrates it spends the whole budget on refreshes
  and text never sharpens. 4s plus PLI is the shape.
- **ICE: werift skips `utun`, browsers mask candidates as mDNS `.local` names.**
  So off-LAN (LTE) had no reachable address at all and only ever said
  reconnecting. Fixed by deriving the Mac's tailnet IPv4 from the CGNAT range
  and passing it as `iceAdditionalHostAddresses`.
- **Bun never reports a client disconnect** (neither `request.signal` nor stream
  `cancel`), and `Bun.serve` treats a streaming response as idle, so
  `idleTimeout: 0` is load-bearing for every long-lived response, SSE included.
- **Vite's proxy drains abandoned upstreams forever.** Destroy on the client
  *response* close when `!writableEnded`; listening on the *request* close is a
  trap that kills every proxied GET at birth.
- **werift's SCTP data channels crash** on Bun and Node alike. Media is fine.
  Never smoke-test werift with a data channel.
- **The Claude browser pane's page is permanently hidden**, which pauses muted
  MSE video but not WebRTC video. Verify MSE playback by canvas readback and
  currentTime, never by `paused`.
- **Hardware-overlay decode does not appear in the pane's screencast**, so a
  working High-profile tile screenshots black there. Sample pixels from the
  element instead.

## Known open issues

1. **`just check` is red before it reaches Swift, and has been all session.**
   `agent-panel-web-check` runs first and fails, so the entire host/client Swift
   build and test half never executes. Cause is environmental, not ours: under
   vitest 3, jsdom 26.1.0 exposes `globalThis.localStorage` as an accessor whose
   getter returns `undefined` (the URL is a healthy `http://localhost:3000`, so
   it is not the opaque-origin case), and every test touching localStorage dies.
   70 failures across `AgentPanelApp.test.tsx` and `sidebarPreferences.test.ts`,
   reproducible on a clean tree. Until this is fixed, **verify Swift changes with
   a direct `xcodebuild`**, and check the gate's own exit code rather than a
   pipeline's. Worth also making `just check` run the Swift half even when the
   web suite fails.
2. **Encoders leak across sidecar hot-reloads.** `bun --watch` keeps the same
   pid and re-reads in place, so the previous module's reader loops keep draining
   orphaned children (which therefore never trip the stalled-write watchdog)
   while the new `sharedEncoders` map knows nothing about them. Observed three
   `--display main` encoders alive at 5% CPU each. Workaround `pkill -f
   grid-encoder`; viewers self-heal. A real fix probably belongs in the encoder
   (exit if no stdin control line and no reader interest for N seconds) or in a
   pid registry the pool can reclaim.
3. **Capture size is fixed at connect**, so pseudo-fullscreen and deep zoom show
   that ceiling as softness. The fix is reconnecting at the larger measured size
   once expanded persists, at the cost of a one-second blink.
4. **Multi-viewer REMB is last-writer-wins.** The honest answer is the minimum
   across viewers; it can land with the grid work.
5. **No ADR yet.** This shape deserves one: transport-only WebRTC for park
   delivery, with the evidence trail above, and MoQ recorded as "rejected for
   now, revisit on native browser playback or the RFC landing" because no browser
   has a native MoQ receiver and the page would have to re-implement the receive
   side we just deleted.

## Still open from the previous handover (different arc, not touched here)

The 2026-08-01 handover (`git show 55155019:HANDOVER.md`) flagged **R230, the
post-handover black screen**, as root-caused but unfixed, and nothing in this
arc went near it. Preserved here so it does not get lost behind a newer
document:

After a WiFi/cellular switch the phone shows black until relaunch. The host
resumes the session in place and pushes a **fresh encoder** (frame ids restart,
new parameter sets) at a client that never tore its own transport down, so
`prepareForStreamHandover()` never fires and the client decodes a new stream
with its old format description, pacer state and layer contents. The client is
never told the stream was replaced. It is a regression: a handover used to
freeze, say "Reconnecting", and recover.

The open decision recorded there, still open: signal the handover explicitly on
resume (correct, costs a wire message) versus letting the client infer it (a
frame id lower than the last seen, or new parameter sets mid-stream; no wire
change, but inference can be wrong). Check what the resume handshake already
carries before choosing. That handover also lists what was measured and
eliminated, so read it before re-chasing anything.

Note the overlap in flavour with this arc: a receiver holding stale state across
a stream replacement is exactly the class of bug the WebRTC path avoids by
letting the transport own stream identity, which may be worth weighing if R230
gets revisited rather than patched.

## Running it

Host must be up (it owns the sidecar and the Screen Recording grant):

```bash
just host-run
```

Then a panel dev server pointed at the host's sidecar, which is what makes
panel and sidecar edits live on the Mac and the phone with no rebuild:

```bash
tools/park-panel-dev.sh host
```

Triage in ten seconds when a tile misbehaves: `tail /tmp/agentdesk-webrtc-diag.log`
separates transport from capture (candidates, ICE state, chosen codec), and
`ps -o pid,etime,%cpu -p $(pgrep -f grid-encoder | tr '\n' ',' | sed 's/,$//')`
says whether the encoder is producing. A connected peer with a 0% CPU encoder is
capture starvation, not transport.

## Next arc, already scoped

**Remote control on the tile.** Input never rides the video (ADR-0005 settled
this); it is a parallel plane. The pieces are named: an `input-bridge` Swift CLI
under the sidecar taking NDJSON on stdin and posting CGEvents (same pattern and
same TCC umbrella as the grid encoder), one `POST /api/park/input` route, and
`toContentPoint()` mapping a finger to a desktop coordinate. Click and scroll
first, keys second. Measure tap-to-photon on the phone before committing to
typing: this path is a glance-and-poke surface, and the daily-driver remote
control crown stays with the owned QUIC pipeline until proven otherwise.
