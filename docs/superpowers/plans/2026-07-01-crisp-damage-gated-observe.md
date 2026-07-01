# Crisp Damage-Gated Observe Implementation Plan

> **For agentic workers:** Design-level plan (no full code by request). Each task states files, interfaces, test intent, and verification. Steps use checkbox (`- [ ]`) syntax. Follow TDD: write the failing test from the stated intent, watch it fail, implement, watch it pass, commit.

**Goal:** Stop `RegionCrispController.observe()` from re-hashing the whole captured surface every crisp window; make crisp CPU proportional to what actually changed, so a settled screen costs ~nothing while streaming.

**Architecture:** `observe()` gains an optional `changedRects` argument. `nil` keeps today's full-surface scan verbatim (the coherence "heal"); a non-nil list runs a gated pass that hashes only tiles overlapping damage plus tiles due for promotion, and trusts already-crisp tiles it did not visit. Because ScreenCaptureKit damage is best-effort (under-reports cursor-vacated pixels, empty means "extent unknown"), the transport still forces a `nil` full-surface heal on a periodic counter, mirroring the proven `ScrollDeltaEngine` heal. The transport also early-outs before the YUV→BGRA convert when there is provably no work.

**Tech Stack:** Swift, XCTest, `xcodebuild`, `just`. Host app under `host/AgentDeskHost`.

## Global Constraints

- Preserve the coherence invariant: a crisp draw (`cacheTile`/`drawCachedTile`) is only ever emitted for a tile whose hash was just computed from the current capture. Trusted (unvisited) crisp tiles are the one exception, bounded by the heal interval; that bound is the ADR decision and must be stated, not silent.
- Preserve the `TileContentCache` pending/commit contract: `observe()` stages slot assignments, the transport commits (`commitEmission`) only on lane send, discards otherwise. No task may commit inside `observe()`.
- Damage rects are a hint, never authoritative. Empty damage on a delivered frame means "something changed, extent unknown" (SCK only delivers on change), not "nothing changed." (`FrameComposer.swift:118`, `ScrollDeltaEngine.swift:240`.)
- No behavior change until Task 6 (transport wiring). Tasks 2-4 add the gated path but leave the transport passing `nil`, so runtime behavior is byte-identical to today and all 14 existing tests stay green.
- Config values are the source of truth: grid `Config.hybridTileGridPx`=128, settle `ownedMediaCrispSettleWindowMs`=200, crisp interval `ownedMediaCrispMinIntervalMs`=100, slots 640. New heal-interval key added in Task 1c.

---

## Dependency map (read before assigning work)

Most implementation touches two files (`RegionCrispController.swift`, then `OwnedMediaTransport.swift`), so the spine is sequential. The genuinely independent, parallel-agentable work is the Phase-0 scaffolding.

```
Phase 0 (PARALLEL — three independent agents):
  1a ADR-0035 (damage-trust + heal model)      ─┐
  1b CPU baseline capture (measurement doc)      ├─ no shared files, run concurrently
  1c Config.ownedMediaCrispHealIntervalWindows  ─┘

Phase 1-4 (SEQUENTIAL — same two files, hard data deps):
  2 observe(changedRects:nil) seam  →  3 gated iteration  →  4 hasDueCandidates
        →  5 (depends on 1c,4)  →  6 transport wiring + early-out + heal counter
        →  7 lock narrowing (independent-ish cleanup, do last)
```

Parallel opportunity is limited on purpose: 1a/1b/1c fan out, the rest is one worker's ordered chain (or subagent-per-task with review between). Do not split Task 2 and Task 3 across parallel agents — they edit the same `observe()` body and will conflict.

---

## Task 1a: ADR-0035 — crisp damage-trust and heal model

**Files:**
- Create: `architecture-decisions/0035-crisp-damage-gated-observe.md` (from `TEMPLATE.md`)
- Reference from: `SPEC.md` (add the ADR number where crisp is described)

**Parallel:** yes (doc only). **Depends on:** nothing.

- [ ] **Step 1: Write the ADR.** Record: damage is best-effort (cite `ScreenCaptureKitFrameSource.swift:245`, `ScrollDeltaEngine.swift:240`); the gated pass trusts unvisited crisp tiles; the correctness bound is a periodic full-surface heal (interval = `ownedMediaCrispHealIntervalWindows`); the accepted worst case is a stale crisp tile for up to one heal interval when damage under-reports a change to that tile, self-healing thereafter (same tradeoff `ScrollDeltaEngine` already accepts). State the rejected alternative (trust damage with no heal) and why (stale crisp never self-heals). `status: accepted`.
- [ ] **Step 2: Commit** (`docs: ADR-0035 crisp damage-gated observe with periodic heal`).

## Task 1b: CPU baseline capture

**Files:**
- Create: `docs/superpowers/measurements/2026-07-01-crisp-cpu-baseline.md`

**Parallel:** yes. **Depends on:** nothing.

This is the feedback loop the whole plan is judged against. Capture it before touching code so the win is measured, not asserted.

- [ ] **Step 1:** With a Release host streaming to the sim (`just sim-fresh-install`), record `ps`-sampled host `%CPU` and a `sample <pid> 3` profile for two scenarios: (a) fully static screen after settle, (b) a small localized change (cursor blink / caret). Note the `extractTileWithHash` share in each. Save numbers + the sample path.
- [ ] **Step 2:** Define the pass target in the doc: static-screen crisp CPU should drop to near-zero (early-out), localized-change crisp CPU should scale with the damaged area, not surface area. Commit the doc.

## Task 1c: Config heal-interval key

**Files:**
- Modify: `host/AgentDeskHost/Config.swift` (near `ownedMediaTileHealIntervalFrames:243` and the crisp keys)
- Modify: `.env.example` (document the knob)

**Parallel:** yes (isolated additive change). **Depends on:** nothing.

**Interfaces produced:**
- `Config.ownedMediaCrispHealIntervalWindows: Int` — env `AGENTDESK_OWNED_MEDIA_CRISP_HEAL_INTERVAL_WINDOWS`, default `10` (≈1s at the 100ms crisp interval). `0` disables gating (always full-scan) as an escape hatch.

- [ ] **Step 1:** Add the key mirroring the existing `positiveInt(...)` pattern; document purpose/default/range in `.env.example`.
- [ ] **Step 2:** Build (`just check` host target compiles) and commit.

---

## Task 2: `observe(changedRects:)` seam — nil preserves current behavior

**Files:**
- Modify: `host/AgentDeskHost/RegionCrispController.swift` (`observe(...)`)
- Test: `host/AgentDeskHostTests/RegionCrispControllerTests.swift` (append)

**Parallel:** no. **Depends on:** nothing (start of the spine).

**Interfaces produced:**
- `mutating func observe(pixels: Data, width: Int, height: Int, bytesPerRow: Int, nowMs: Int, changedRects: [PixelRect]? = nil) -> RegionCrispEmission`
- Extract the per-tile decision block (current lines 180-234) into a private helper applied per visited tile, and the tile-selection into a private helper that returns the ordered `[CellKey]` set. For this task the selection helper returns the full grid in the exact current row-major order when `changedRects == nil`.

**Intent:** pure refactor. `nil` (the default) must produce byte-identical emissions to today, so all 14 existing tests pass unchanged. Only the internal shape changes.

- [ ] **Step 1:** Write a test asserting `observe(... )` (no `changedRects`) still promotes/reverts/throttles exactly as the existing `testSettledTilePromotesToCrispCacheTile` and `testPartialEdgeTilesAndSequentialByteRanges` do — i.e. re-run the existing suite; it is the regression gate. Add one new test that pins row-major visit order via the sequential byte-range assertion at a non-square surface.
- [ ] **Step 2:** Run the crisp suite, confirm current tests fail only if the refactor diverges.
- [ ] **Step 3:** Implement the extraction (add the param defaulting `nil`; move the loop body and selection into helpers; `nil` path unchanged).
- [ ] **Step 4:** Run the crisp suite: all green.
- [ ] **Step 5:** Commit (`refactor: extract crisp tile selection behind observe(changedRects:), nil = full scan`).

## Task 3: gated iteration for non-nil `changedRects`

**Files:**
- Modify: `host/AgentDeskHost/RegionCrispController.swift` (tile-selection helper)
- Test: `host/AgentDeskHostTests/RegionCrispControllerTests.swift` (append)

**Parallel:** no. **Depends on:** Task 2.

**Interfaces consumed:** the selection helper + per-tile block from Task 2.
**Interfaces produced:** when `changedRects != nil`, the selection helper returns the ordered union of (a) tiles overlapping any rect in `changedRects` (clamped, grid-snapped, same walk as `reactToDamage`) and (b) non-crisp cells whose `stableSinceMs` settle window has elapsed (the due-for-promotion set). Unvisited crisp tiles are trusted (not re-hashed). Visited tiles run the identical per-tile block, so promotion still re-hashes and verifies before caching.

**Intent to test (describe, do not write full code):**
- Gated change detection: a crisp tile whose pixels change AND whose region is in `changedRects` reverts to video; the same change with `changedRects == []` (empty, not overlapping) is NOT reverted by `observe` (it is trusted until heal/damage) — this pins the deliberate tradeoff.
- Gated promotion: a tile that settled promotes on a gated pass even when `changedRects` is empty, because it is a due candidate; a not-yet-due tile does not.
- Over-report absorption: a tile in `changedRects` whose bytes are unchanged and is due still promotes (re-hash sees no change).
- Coherence: a due candidate whose content actually changed (damage missed it) is caught by the promote-time re-hash and reset, never cached stale.

- [ ] **Step 1:** Write the four tests above from intent.
- [ ] **Step 2:** Run them; watch them fail (selection helper ignores `changedRects`).
- [ ] **Step 3:** Implement the non-nil selection (damaged-tile walk ∪ due-candidate scan of `cells`, deterministic row-major order).
- [ ] **Step 4:** Run the crisp suite (new + existing): all green.
- [ ] **Step 5:** Commit (`feat: damage-gated tile selection in observe(changedRects:)`).

## Task 4: `hasDueCandidates` for the transport early-out

**Files:**
- Modify: `host/AgentDeskHost/RegionCrispController.swift`
- Test: `host/AgentDeskHostTests/RegionCrispControllerTests.swift` (append)

**Parallel:** no. **Depends on:** Task 3 (same file).

**Interfaces produced:**
- `func hasDueCandidates(nowMs: Int) -> Bool` — true iff any non-crisp cell's settle window has elapsed. Non-mutating, no pixels, cheap (timestamp scan of `cells`). Lets the transport decide "is there promotion work?" without converting BGRA or hashing.

**Intent to test:** false on a fresh controller; true once a tracked tile passes the settle window; false again after those tiles promote to crisp.

- [ ] **Step 1:** Write the test. **Step 2:** Watch it fail. **Step 3:** Implement. **Step 4:** Green. **Step 5:** Commit (`feat: RegionCrispController.hasDueCandidates for work early-out`).

---

## Task 5: transport heal counter + gated dispatch (no early-out yet)

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift` (`CrispState:37`, `processCrisp:222`)

**Parallel:** no. **Depends on:** Task 1c (config key) and Task 4 (observe signature + hasDueCandidates).

**Interfaces consumed:** `observe(... changedRects:)`, `Config.ownedMediaCrispHealIntervalWindows`.
**Design:**
- Add `crispWindowsSinceHeal: Int` to `CrispState`.
- In `processCrisp`, after the interval/pacing gates, compute `healDue = healInterval > 0 && crispWindowsSinceHeal >= healInterval` (or `healInterval == 0`). Pass `changedRects: nil` to `observe` when `!surfaceInitialized || healDue`, else pass `frame.damageRects`. Reset/advance `crispWindowsSinceHeal` accordingly.

**Verification:** no correct unit-test seam exists at the transport (needs live QUIC/lane) — state this in the commit per the diagnose "absence of seam is a finding" rule. Verified by: (a) `just check` host suite still green (controller tests unaffected), (b) the CPU benchmark from Task 1b re-run after Task 6.

- [ ] **Step 1:** Implement the heal counter + gated dispatch. **Step 2:** `just check` (host builds, tests green). **Step 3:** Commit (`feat: crisp heal counter; observe gated on damage between heals`).

## Task 6: transport work early-out before extractBGRA

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift` (`processCrisp:222`)

**Parallel:** no. **Depends on:** Task 5.

**Design:** before the `extractBGRA` convert, under `crispGate`, compute `hasWork = healDue || !surfaceInitialized || !frame.damageRects.isEmpty || state.controller.hasDueCandidates(nowMs)`. If `!hasWork`, skip the convert and `observe` entirely for this window (no lane traffic, no commit needed since nothing was staged). This is the static-screen win: a fully settled screen does zero crisp hashing.

**Verification:** re-run Task 1b measurement. Expect static-screen host crisp CPU at/near zero and `extractTileWithHash` off the profile in the static case; localized-change CPU scaling with damaged area. Record the before/after in the measurement doc. Device confirmation via `just fresh-release-diagnostic-run` (user go-ahead) watching the host `owned-media` log for unchanged crisp `tiles=`/`payloadBytes=` behavior under motion.

- [ ] **Step 1:** Implement the early-out. **Step 2:** `just check`. **Step 3:** Re-run the CPU benchmark; append before/after to the measurement doc. **Step 4:** Commit (`perf: skip crisp convert+hash when no damage and nothing due`).

## Task 7: narrow the crispGate lock (cleanup)

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift`

**Parallel:** no (same file), but independent of correctness — do last. **Depends on:** Task 6.

**Design:** today the full-surface hash runs while holding `crispGate` (`processCrisp:259`), so a multi-ms scan blocks `attachGraphicsLane`/`handleGraphicsResetRequest`/`processCrispDamage`. After Tasks 5-6 the scan is usually tiny, but the heal scan is still full-surface. Evaluate splitting: keep state reads/writes and `lane.send` under the lock, but this is a smaller concern than the CPU work and may be left as a documented note if the split risks the pending/commit ordering. If the split is not clearly safe, do NOT force it — record why in a comment and stop.

- [ ] **Step 1:** Assess and either narrow the lock (state green via `just check`) or document why it stays. **Step 2:** Commit.

---

## Self-review checklist (run after implementing)

- **Coherence:** every `cacheTile`/`drawCachedTile` still rides a just-computed hash except deliberately-trusted crisp tiles, which the heal reconciles within `ownedMediaCrispHealIntervalWindows`. Confirm the ADR states this bound.
- **Pending/commit:** `observe` still only stages; the transport still commits/discards exactly once per window that ran. The early-out path stages nothing, so it must not call commit/discard.
- **Signature consistency:** `changedRects` param, `hasDueCandidates(nowMs:)`, `crispWindowsSinceHeal`, `ownedMediaCrispHealIntervalWindows` named identically across controller, transport, config, and tests.
- **Existing tests:** all 14 green throughout (the `nil` path is byte-identical); new tests cover only the gated path.
- **Measured, not asserted:** Task 1b baseline and Task 6 after-numbers both live in the measurement doc.
