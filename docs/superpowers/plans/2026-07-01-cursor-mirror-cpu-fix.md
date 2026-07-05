# Cursor-Mirror CPU Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement this task-by-task. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Keep the low-latency, sharp cursor overlay, but stop `CursorMonitor` from spiking CPU, by detecting cursor changes with a cheap window-server signal instead of re-encoding + hashing the cursor image 20×/second.

**Architecture:** Event-gated instead of poll-and-fingerprint. Read a cheap monotonic cursor "seed" from the window server each tick (the same class of signal TeamViewer/AnyDesk use); run the expensive path — image fetch → PNG encode → content hash → push — ONLY when the seed changes. The private-API seed sits behind a `CursorChangeSignal` protocol with an injectable fake and a live smoke test, mirroring exactly how `SpacesProvider` isolates SkyLight/CGS today.

**Tech Stack:** Swift, macOS 26 host, CoreGraphics/SkyLight private symbols via `dlopen`/`dlsym` (already used in `SpacesProvider.swift`), Swift Testing.

## Root cause (why ours spikes and theirs does not)

`CursorMonitor.tick()` (`CursorMonitor.swift:81`) runs at 20 Hz (`interval = 0.05`) and, **every tick unconditionally**, calls `sample.image.tiffRepresentation` (rasterize + TIFF-encode the cursor) then `SHA256(tiff)` — purely to detect whether the cursor changed. The `hash != lastHash` dedup happens *after* that work. So ~99% of ticks re-encode + hash an image that did not change and throw the result away. Profiled leaf self-time (crisp-off, sha 546b088): `CursorMonitor.tick` + `hash` + sampler closure ≈ 10%+ of on-CPU, plus its share of the `AccelerateCrypto_SHA256_compress` / vImage / objc churn. It is **steady and content-independent** — the same cost whether the screen is busy or idle.

TeamViewer/AnyDesk gate the encode on a cheap OS cursor-change counter; steady-state cost is one integer read. This plan adopts that.

## Global Constraints

- Private window-server symbols MUST sit behind a type with an injectable fake AND a live smoke test (the `SpacesProvider` precedent; the smoke test is the canary for private-API drift across macOS versions). Verbatim pattern to mirror: `host/AgentDeskHost/SpacesProvider.swift:35-70` (SkyLight struct, `dlopen(skylightPath)`, `resolve("SLS…","CGS…")`) and `host/AgentDeskHostTests/SpacesProviderTests.swift:25-40` (smoke test).
- No wire-format change: `CursorImagePush` (`SharedTypes.swift:2343`) and the client are untouched. The content hash stays the client cache key (`CursorImageStore`).
- No behavior regression: animated cursors (beachball/spinner) must still mirror; a stationary cursor whose *shape* changes in place must still mirror.
- `CursorMonitor` DI stays intact (`sampler`, `positionSampler` closures) — add the seed source as one more injected dependency.

---

### Task 1: Cheap cursor-change signal, isolated + smoke-tested

**Files:**
- Create: `host/AgentDeskHost/CursorChangeSignal.swift` — `protocol CursorChangeSignal { func currentSeed() -> UInt64 }` + a CGS/SkyLight-backed conformer that `dlsym`s the seed symbol via the same resolver shape as `SpacesProvider`.
- Create: `host/AgentDeskHostTests/CursorChangeSignalTests.swift`
- Modify: `host/AgentDeskHost.xcodeproj/project.pbxproj` — wire the new source + test files (mirror a sibling's 4 pbxproj entries; an unwired test silently never runs).

**Interfaces:**
- Produces: `CursorChangeSignal.currentSeed() -> UInt64` (monotonic-ish; any change ⇒ a different value). Consumed by Task 2.

**Design notes (no full code per project convention):**
- Resolve the seed the same way SpacesProvider resolves its symbols: `dlopen` the already-used SkyLight path, `dlsym` the seed symbol. **Spike first** to confirm the exact symbol on macOS 26 — candidates in priority order: `CGSCurrentCursorSeed` / `SLSCurrentCursorSeed` (connection-less int seed), else derive a seed from `CGSGetCursorData`/`SLSGetCursorData` size+location, else IOHID event-system seed. Whichever resolves, wrap it so a resolution failure returns a fixed sentinel (never crash) and Task 2 falls back to its heartbeat.
- Keep the connection id via the existing `SLSMainConnectionID/CGSMainConnectionID` binding if the chosen symbol needs it.

**Steps:**
- [ ] Spike: in a throwaway `main`/test, `dlsym` each candidate seed symbol and log which resolves on this macOS; confirm the returned value changes when the system cursor changes (arrow → I-beam). Record the winner in the file's header comment.
- [ ] Write the protocol + CGS-backed conformer following the `SpacesProvider` SkyLight-struct shape (resolution-failure ⇒ sentinel).
- [ ] Write the live smoke test (canary): assert `currentSeed()` returns without crashing; assert two reads across a forced `NSCursor` change differ. Tolerate CI headless like `SpacesProviderTests` does (record an Issue, don't hard-fail if the window server is absent).
- [ ] Wire pbxproj (source + test), run `just check`, commit.

**Escalate, do not invent:** if no seed symbol resolves on macOS 26 and only an on-device HITL spike can confirm, stop and surface it — do not ship a guessed symbol.

---

### Task 2: Gate the expensive path on seed change

**Files:**
- Modify: `host/AgentDeskHost/CursorMonitor.swift` (`tick()` ~`:81-108`, add injected `changeSignal`, `lastSeed`, heartbeat state).
- Modify: `host/AgentDeskHostTests/CursorMonitorTests.swift` (add seed-scripted cases).

**Interfaces:**
- Consumes: `CursorChangeSignal` from Task 1 (injected via `init`, default = the CGS-backed conformer, like `sampler` defaults to `systemSampler`).

**Design notes:**
- New `tick()` order: (1) `tickPosition()` as today; (2) read `seed = changeSignal.currentSeed()`; (3) if `seed == lastSeed` AND not due for a heartbeat re-fingerprint → return (the cheap steady path — no image fetch, no TIFF, no SHA256); (4) on change/heartbeat → fetch `NSCursor` image, PNG-encode ONCE, hash the **PNG** (drop the separate `tiffRepresentation`), compare to `lastHash` (guards against a seed bump that did not actually change the pixels, and de-dups the client cache), push on real change.
- Heartbeat: a low-frequency forced re-fingerprint (e.g. every ~2 s) as a correctness backstop for a stale/sentinel seed — same "periodic heal" idea as the crisp controller (`Config.ownedMediaCrispHealIntervalWindows`). Add a `Config` knob for the interval; default conservative.
- Animated cursors: seed bumps per frame ⇒ push per frame. Cap with an image-push rate limit (reuse the interval knob or a min-gap) so a beachball cannot re-encode at 60 Hz.

**Steps:**
- [ ] Add the seed-constant test: fake seed held constant over 100 `tick()`s ⇒ zero image encodes / zero `onChange` pushes (assert via a counting sampler). This is the regression lock for the CPU fix.
- [ ] Add the seed-change test: one seed bump ⇒ exactly one push; stable content hash for the same image across two different seeds (client cache dedups).
- [ ] Add the heartbeat test: sentinel/constant seed but heartbeat elapsed ⇒ a re-fingerprint occurs (backstop works even if the seed source is dead).
- [ ] Implement the gate + PNG-hash + heartbeat; make the constant-seed test pass.
- [ ] `just check`, commit.

---

### Task 3: Rate + threading cleanup

**Files:**
- Modify: `host/AgentDeskHost/CursorMonitor.swift` (timer/rate), `Config.swift` (interval knobs).

**Design notes:**
- The seed read is cheap, so the 20 Hz poll is fine to keep, but make the interval explicit/config-driven rather than a magic `0.05`. Keep position emit gated by `shouldEmitPosition` (unchanged — it already only fires when remote input is inactive and de-dups on `lastPosition`).
- The `tick` runs on `.main` (`DispatchSource… queue: .main`). Encode is now rare, so this is likely fine; note it. If a spike shows the on-change encode ever janks the main queue, move the encode-on-change off MainActor (the position path must stay responsive). Decide from measurement, don't pre-optimize.

**Steps:**
- [ ] Replace magic intervals with `Config` knobs (env-overridable, defaults matching today's feel).
- [ ] Test: position still emits on move while the image seed is constant (image and position paths independent).
- [ ] `just check`, commit.

---

### Task 4: Verify the win

**Steps:**
- [ ] Re-profile crisp-off on a clean sim bring-up (`host-run-release` + `client-sim-reinstall-release` + `pair-sim`, then `sample`): `CursorMonitor.tick`/`hash` self-time drops from ~10% of on-CPU to ~0 steady; `AccelerateCrypto_SHA256_compress` leaf gone from the steady path.
- [ ] Confirm cursor shape still mirrors on the client (change shapes over a terminal/text field/resize handle; beachball animates) and position tracking is unchanged.
- [ ] Update `docs/superpowers/measurements/2026-07-01-crisp-cpu-baseline.md` with the before/after CursorMonitor number.

---

## Parallelization

- Task 1 (signal source + smoke test) and the Task 2 **test scaffolding** (counting sampler, scripted-seed cases) are independent — build concurrently.
- Task 2 impl depends on Task 1's protocol. Task 3 after Task 2. Task 4 last (needs a device/sim, gated on user go-ahead per AGENTS.md).

## Out of scope — related follow-up (own decision, likely an ADR)

`ScreenCaptureKitFrameSource.swift:110` sets `config.showsCursor = true`, so the cursor is also baked into the HEVC video (drawn twice). Setting it `false` would make the overlay authoritative, cut cursor-move video damage/motion (less encode), and remove the double-draw smell — but it changes what the video stream contains and interacts with the crisp path. That is a behavior/UX change with its own tradeoffs; keep it separate from this CPU fix. Flag for a follow-up decision.
