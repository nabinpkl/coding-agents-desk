# Handover — 2026-08-01

Branch `main`, in sync with `origin/main`. Uncommitted files in the tree belong to a
**parallel session's** agent-feed work, not this arc — leave them alone.
(Previous handovers are preserved in this file's git history.)

**Gate**: `just check` green (exit 0) — 172 host XCTest + 713 swift-testing in 92 suites.
`just sim-test` green (exit 0) — 497 client tests in 59 suites.

**The one thing to do next**: R230's root cause is found but **not fixed** — the client is
never told the host replaced its media stream on a resume, so it decodes a new stream with old
state and the screen goes black. Section 4 has the diagnosis and the one open design decision.
Nothing in `TASKS.md` reflects any of this document.

Arcs this session, newest first (`feb6d8ef`, `4a8e76ce`, `aeb52bc0` interleave from the
parallel agent-feed session — ignore them):

| commit | what |
|---|---|
| `aa41559f` | read the sample buffer renderer, not the deprecated layer properties |
| `ee800d8b` | log surface generation; report the crisp overlay above the video |
| `f55590f9` | report what the display layer does, not just what we hand it |
| `6f04718a` | stop the media transport a resume supersedes |
| `bc514ab3` | make the resolution climb-back earn a long clean streak |
| `4e9053ff` | require two consecutive stale windows before collapsing the ladder |
| `417897aa` | make a rescale wait for evidence, since only it costs a keyframe |
| `9547f203` | reshape R231 as decoupling, not a dwell on the whole rung |

---

## 1. The quality ladder (R231 / R231b / R231c) — confirmed on hardware

### The shared defect

The ladder is one ordinal emitting bitrate, fps and resolution together, but they are not the
same kind of instruction. Bitrate and fps are live properties of the compression session and
cost nothing. **Resolution is fixed at session creation**, so changing it recreates the
`VTCompressionSession`, emits an IDR, and destroys every long-term reference inside it.

The same mistake appeared in three places: the expensive axis shared a threshold with the cheap
ones.

### What changed

- **R231** — the rung's resolution is a *request* that must persist (`resolutionDownDwellMs`,
  10s) before the encoder acts. Bitrate and fps still move on the window that asked. Gated
  **downward only**: the climb back already had a gate, `recover()` raising resolution through a
  probe phase with a clean-streak requirement, warmup and rollback. An earlier version clamped
  both directions and broke the probe outright — 29 test failures. Freeze and probe-rollback
  bypass the wait, being evidence about the setting actually running rather than a guess.
- **R231b** — `stalePressure` (`staleRecoveryCount > 0`: one abandoned frame, no magnitude) now
  needs `staleDownWindows` (2) consecutive windows. A clean *or idle* window breaks the run.
  The streak is deliberately **not** folded into `resetPressureStreaks()` — the stale branch
  calls that on its way through to clear the cadence streak, so folding it in would have the
  signal wipe the counter it is accumulating.
- **R231c** — the climb back needs `resolutionRaiseCleanMs` (30s), separate from
  `raiseCleanWindows` (4s) which gates every other recovery step. It needs its own accumulator:
  `cleanRecoveryMs` is zeroed each time it reaches `requiredRecoveryMs`, capping it at 4s and
  making "clean for thirty seconds" unrepresentable in it. The wait **holds** the recovery
  sequence rather than letting fps overtake — that sequence is one axis at a time by design, so
  a probe failure is attributable to the axis that moved.

### The measurements (25-minute host log, before the changes)

- 103 resolution changes: **51 up, 52 down** — a pure oscillation with no net drift.
- An upward rescale survived a **median 22.4s**; **80% were undone within 30s**. Four times in
  five the keyframe bought nothing. Largest measured: 122,041 bytes, spent climbing back onto a
  link that had just failed at that scale.
- Stale pressure fired in **59 of 2,664 windows**, in 51 bursts of which **47 (92%) lasted
  exactly one window**. Two consecutive windows would have fired 4 times instead of 51.
- Magnitude thresholds were all weaker: `>=2` stale frames leaves 42% of firings, `>=3` leaves
  29%, a 250-permille rate leaves 39%. The median firing window produced only 7 frames, so a
  rate mostly measures how much the screen happened to be changing.

### Confirmed on device, across a WiFi→cellular handover

| | before | after |
|---|---|---|
| resolution changes | ~4.1/min | 1 in 2.3 min |
| `stale-capacity-down` | 59 firings | **0** |
| `stale-hold` | n/a | 2 |

The ladder descended once, one step at a time (`capacity-down` → `survival-down` →
`emergency-down`), then sat at `at-emergency-floor` instead of sawtoothing.

**Not verified**: R231c's climb-back threshold. The link stayed bad all run (`latency-hold` ×31
on cellular) so the ladder never got clean enough to climb. Its 30s default also rests on an
inference — clean-time-*before*-climbing and survival-*after*-climbing are correlated, not the
same measurement.

### Settled — do not relitigate

**The codec route is closed.** Changing resolution requires an IDR at the bitstream level: HEVC
has no reference picture resampling, a reference picture must match the dimensions of the
picture referencing it, and a new SPS activates only at an IRAP. The codecs that resample
references (AV1, VP9, VVC) are not encodable on the host — `VTCopyVideoEncoderList` on an
M-series Mac returns hardware encoders for H.264, HEVC, ProRes and JPEG only. The iPhone decodes
AV1 and VVC and that is useless, because nothing on the Mac can feed it. Doing it less often is
the only lever.

---

## 2. Media transport leaked on every resume (fixed, `6f04718a`)

`SessionRegistry.noteReady` has two branches. A genuine replacement (new session id) calls
`endSession`, which stops the old transport. **A resume keeps the same session id**, so it took
`.sameSession`, which did not — the superseded transport was overwritten in the dictionary.

Overwriting does not stop it: `startMediaTransport` observes `connectionState` from a Task that
captures the transport **strongly**, and that stream only finishes inside `stop()`. So the
dropped transport never deallocated and kept its link-health tick running for the process
lifetime.

Measured on device: still ticking quality windows **4.7 minutes** after being replaced, at rung
0, three frames frozen in flight, `oldestInflightMs` climbing linearly. Two media transports
against one client. Verified fixed on device — a resume now leaves exactly one window-id
sequence.

**This was not the black screen.** The black screen persisted with one transport.

---

## 3. Instrumentation now available

Landed in `f55590f9`, `ee800d8b`, `aa41559f`. On an attached-console run these appear in
`/tmp/agentdesk-client-console.log`:

- `video-render-diagnostics` — renderer status/error, `requiresFlush`, `readyForMore`, geometry
  (`bounds`, `frame`, `hidden`, `opacity`, `attached`), `timebaseRate`, crisp overlay state,
  `surfaceGen`, `enqueued` count. Emitted on change, plus unconditionally on the window boundary
  and the recovery path.
- `displayedFrame=present|none` — `displayedPixelBuffer()`, the only signal reporting what is
  **actually on screen** rather than what was handed over.
- `video-performance` — `totalNumberOfFrames` / `dropped` / `corrupted`, against the enqueue count.
- `video-renderer-decode-failed` — the renderer's `didFailToDecode` notification and its
  `NSError`. The layer reports no per-sample decode result; this is the only push signal.

Host side: `owned media video sent … gen=N` carries the surface generation for correlation.

**Still missing**: the luma of `displayedPixelBuffer()`. Everything above reports intent or
liveness; sampling those pixels would say whether the displayed frame is itself black. That
splits the remaining space — a black displayed frame points upstream of display, a non-black one
points at the view hierarchy.

---

## 4. R230, the black screen — root cause found, fix not written

### Symptom

After a WiFi↔cellular switch the phone shows black. It survives further transport rebuilds and
switching back. It clears only on app relaunch.

### Root cause

`prepareForStreamHandover()` — the reset that adopts a new stream — is called from exactly one
place, `PairingViewController.swift:703`, inside the branch where the **client** tears down its
own transport with `preservingSessionSurfaces`.

The handover does not take that path. The **host** resumes the session in place
(`session resuming` → `media transport started`) and pushes a new stream at a client that never
stopped its transport. So:

- the host builds a **fresh encoder** — frame ids restart at 1, new parameter sets
- the client keeps its **old decoder format description, old pacer state, old layer contents**
- `prepareForStreamHandover` fires **zero** times
- the "Reconnecting…" label never appears

**The client is never told the stream was replaced.**

This is a **regression**, and the operator's report is what located it: a handover used to
freeze, say it was reconnecting, and recover. It now goes black silently. Bisectable across the
handover arc — `19dab2a2`, `aeffb269`, `de228969`, `549cb2d5`, `d07df7ab`, `01498b3f`,
`0d29c0f5`, `efaca398`, `5ce75e90`, `aee9ac5c`. `d07df7ab` introduced
`prepareForStreamHandover`.

### The open decision

- **Explicit** — the host signals a stream handover on resume; the client runs
  `prepareForStreamHandover`. Correct and obvious, costs a wire message.
- **Inferred** — the client detects it (frame id lower than last seen, or new parameter sets
  mid-stream) and resets itself. No wire change, but inference can be wrong.

Check what the resume handshake already carries before picking.

### Eliminated — do not re-chase

All measured, most on a live black screen:

| eliminated | evidence |
|---|---|
| host capture / encode / transport | real bytes, keyframes delivered and acked |
| LTR reference loss | full IDRs (69KB, 57KB, 25KB) also fail — a keyframe needs no history |
| zombie transport | fixed; black persists with one transport |
| decoder wedge | `status=rendering`, zero decode failures, on the **non-deprecated** renderer |
| display layer wedge | `displayedFrame=present`, `totalFrames` climbing **while black** |
| crisp overlay covering video | unpainted surface is all-zero BGRA under `premultipliedFirst` = fully transparent |
| surface generation mismatch | the client's video path never reads `surfaceGeneration`; only the crisp path does |
| stale-frame discards | zero `mediaStalePresentationSkipped` |
| stalled control timebase | `timebaseRate=none` — none is set, same as when working |
| Mac display sleep | `displaysleep 0` |

Also confirmed harmless, though it looks wrong: the crisp overlay is revealed by a bare
`resetSurface` even when crisp is disabled. `ownedMediaVideoSinkCompositesCrispOverlayOver
VideoFloorWithoutSwap` asserts that reveal deliberately (R7 / ADR-0034), and an unpainted
surface is transparent, so the video shows through. Changing it means rewriting a test that
encodes intent, to fix nothing.

### Two traps that cost real time

- **The layer's own properties are deprecated.** `AVSampleBufferDisplayLayer.status`, `.error`,
  `.timebase` and `.enqueueSampleBuffer:` are deprecated as of iOS 18 in favour of
  `sampleBufferRenderer`. `OwnedMediaDisplayQueuePolicy` — the existing wedged-layer recovery —
  decided from the deprecated values, which is why it never fired. `aa41559f` moves the reads to
  the renderer and keeps the legacy values as `legacyStatus`/`legacyError`; if the two ever
  disagree, that disagreement is the finding.
- **Everything else measures intent, not pixels.** `advanceVideoMilestone(.decoderEnqueued)` and
  `.presentationAttempted` both fire at enqueue. A wedged layer and a working one printed
  identically, which is why this survived three sessions and produced a wrong "wedged display
  layer" framing that shaped the whole investigation.

---

## 5. Operational notes that will otherwise cost time

- **`git add -A` is dangerous here.** A parallel session works in this repo on the same branch
  and has already swept another session's uncommitted files into its commits. Stage explicit
  paths. Where a file is genuinely shared, build the commit through a temporary index
  (`GIT_INDEX_FILE=… git read-tree HEAD; git add <paths>; git write-tree; git commit-tree;
  git update-ref`) so `.git/index` is never touched — then re-`git add` your own paths so the
  shared index does not show them as deletions.
- **Verify the gate's exit code, not the pipeline's.** `just check | tail` reports `tail`'s
  status. Redirect to a file and echo `$?` separately. A `cmd | tail || fallback` construct
  silently skips the fallback.
- **Watch the shell's working directory.** A `cd` persisted across calls and caused a `python3`
  edit to write nowhere and an `xcodebuild` to fail on a relative project path. Use absolute paths.
- **`sim-test` can fail on a stale precompiled module cache** (`malformed or corrupted
  precompiled file`, onnxruntime). Remove
  `.build/DerivedData/Build/Intermediates.noindex/SwiftExplicitPrecompiledModules` and
  `.build/DerivedData/ModuleCache.noindex`, then re-run.
- **The phone goes `unavailable` to `devicectl` when its WiFi is off.** After a handover test
  that left WiFi disabled no install will work until it is back on. `xcrun devicectl list
  devices` tells you.
- **Host-only changes need no client reinstall.** `just host-run` builds and launches the Mac
  host and returns; it does not touch the phone. The client leg is separate:
  `just client-install-release`, then `just iphone-console-run` for an attached console.
- **Device installs, launches and relaunches are a checkpoint** — state the command, wait for a
  go-ahead. See `AGENTS.md`.
- **Reading the host log**: `mediaQualityDecision` carries `staleRecoveryCount`, `stalePressure`,
  `reason`, `changedAxes` per window; `mediaQualityWindow` carries `completedFrames`, `gapSkips`,
  `abandonedFrames`. Invoke `/usr/bin/log` explicitly — bare `log` resolves to the zsh builtin.
- **Two log-analysis traps**, both of which produced wrong numbers that reached commit messages:
  keying per-window stats by `windowId` in a dict collapses duplicates (ids repeat across
  reconnects) and undercounts by ~40% — parse as a list in file order. And
  `grep -c "stale-capacity-down"` over-counts ~4x, because one event writes that reason onto the
  `mediaQualityDecision`, `bitrate-step`, `resolution-step` and `fps-step` lines.

---

## 6. Open items

- **R230's fix** — decide explicit vs inferred handover signalling, then implement (section 4).
- **`TASKS.md` records none of this.** R230 and R231 still describe the original framing,
  including the superseded "wedged display layer" theory.
- **R231c unverified on hardware**, and its threshold rests on an inference.
- **The luma sample** on `displayedPixelBuffer()` (section 3).
- **Duplicate task ids D189–D193** in `TASKS.md` (pre-existing).
