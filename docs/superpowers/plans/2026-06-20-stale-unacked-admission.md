# Stale Unacked Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop stale owned-media ACKs from triggering large recovery keyframes, and use stale unacked frames only as an admission/backpressure signal.

**Architecture:** The host keeps single-surface owned QUIC plus VideoToolbox. `OwnedMediaEncodeAdmission` remains the state machine, but stale unacked frames are abandoned for accounting and cause a hold/coalesce decision instead of setting `pendingKeyframeRequest`. Keyframes remain tied to initial frame, periodic normal mode, explicit client keyframe request, decoder continuity recovery, and post-drain timeout recovery.

**Tech Stack:** Swift, Swift Testing, Network.framework QUIC datagrams, VideoToolbox, `just check`, physical iPhone attached-console diagnostics.

---

## File Structure

- Modify `host/AgentDeskHost/SharedTypes.swift`
  - Remove `OwnedMediaKeyframeReason.staleUnackedRecovery`.
  - Replace `staleUnackedRecoveryDecision` with stale abandonment that returns a non-keyframe hold decision.
  - Keep abandoned stale counters on `OwnedMediaAdmissionDecision` so existing diagnostics still show when the stale path fired.
- Modify `host/AgentDeskHost/OwnedMediaTransport.swift`
  - Remove `recovery-keyframe-admitted reason=stale-unacked` logging.
  - Keep `stale-unacked-abandoned` logging.
  - Ensure explicit client `keyframe-request` remains the only non-initial immediate keyframe request path outside post-drain recovery and periodic normal-mode keyframes.
- Modify `host/AgentDeskHostTests/ScrollQualityTests.swift`
  - Replace stale recovery tests with stale admission/coalescing tests.
  - Keep existing explicit client keyframe request and post-drain recovery coverage.
- Modify `.env.example`
  - Change `AGENTDESK_OWNED_MEDIA_STALE_UNACKED_MS` comment from recovery-keyframe wording to admission-hold wording.
- Modify `SPEC.md` and `TASKS.md`
  - Update current behavior notes so stale unacked means coalescing/backpressure, not recovery keyframe.

## Task 1: Host Admission Tests For Stale Unacked Holds

**Files:**
- Modify: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Replace the stale recovery test with a hold/coalesce test**

Change `ownedMediaAdmissionAbandonsStaleUnackedAndForcesRecoveryKeyframe` to:

```swift
@Test func ownedMediaAdmissionAbandonsStaleUnackedWithoutForcingKeyframe() {
    var admission = OwnedMediaEncodeAdmission()
    let backpressure = Self.backpressureConfig()

    _ = admission.noteAck(
        frameId: 10,
        renderGapMs: 90,
        frameAgeMs: 120,
        clientBacklogFrames: 1,
        clientBacklogBytes: 10_000,
        nowUptimeNs: 1_000_000_000,
        config: backpressure
    )
    admission.noteSent(
        frameId: 11,
        bytes: 10_000,
        capturedAtUptimeNs: 1_010_000_000,
        isKeyframe: false,
        nowUptimeNs: 1_020_000_000,
        config: backpressure
    )

    let decision = admission.decision(nowUptimeNs: 1_370_000_000, config: backpressure)

    #expect(!decision.shouldEncode)
    #expect(!decision.forceKeyframe)
    #expect(!decision.allowPeriodicKeyframe)
    #expect(decision.keyframeReason == nil)
    #expect(decision.holdReason == "stale-unacked")
    #expect(decision.abandonedStaleUnackedCount == 1)
    #expect(decision.abandonedStaleUnackedBytes == 10_000)
    #expect(decision.abandonedStaleUnackedOldestFrameId == 11)
    #expect(admission.unacknowledgedFrameCount == 0)
}
```

- [ ] **Step 2: Replace stale keyframe-inflight recovery expectations**

Change `ownedMediaAdmissionAbandoningStaleKeyframeClearsInflightKeyframe` so the stale keyframe is cleared but no replacement keyframe is admitted:

```swift
@Test func ownedMediaAdmissionAbandoningStaleKeyframeClearsInflightWithoutImmediateReplacement() {
    var admission = OwnedMediaEncodeAdmission()
    let backpressure = Self.backpressureConfig()

    admission.noteKeyframeRequested()
    let keyframe = admission.decision(nowUptimeNs: 1_000_000_000, config: backpressure)
    #expect(keyframe.forceKeyframe)
    admission.noteSent(
        frameId: 11,
        bytes: 220_000,
        capturedAtUptimeNs: 1_000_000_000,
        isKeyframe: true,
        nowUptimeNs: 1_010_000_000,
        config: backpressure
    )
    _ = admission.noteAck(
        frameId: 10,
        renderGapMs: 90,
        frameAgeMs: 120,
        clientBacklogFrames: 1,
        clientBacklogBytes: 10_000,
        nowUptimeNs: 1_020_000_000,
        config: backpressure
    )

    let decision = admission.decision(nowUptimeNs: 1_360_000_000, config: backpressure)

    #expect(!decision.shouldEncode)
    #expect(!decision.forceKeyframe)
    #expect(decision.keyframeReason == nil)
    #expect(decision.holdReason == "stale-unacked")
    #expect(decision.abandonedStaleUnackedCount == 1)
    #expect(admission.keyframeInFlightFrameId == nil)
}
```

- [ ] **Step 3: Add explicit client request coverage after stale abandonment**

Add a test proving the real recovery path still works after stale abandonment:

```swift
@Test func ownedMediaAdmissionAllowsExplicitClientKeyframeAfterStaleAbandonment() {
    var admission = OwnedMediaEncodeAdmission()
    let backpressure = Self.backpressureConfig()

    _ = admission.noteAck(
        frameId: 10,
        renderGapMs: 90,
        frameAgeMs: 120,
        clientBacklogFrames: 1,
        clientBacklogBytes: 10_000,
        nowUptimeNs: 1_000_000_000,
        config: backpressure
    )
    admission.noteSent(
        frameId: 11,
        bytes: 10_000,
        capturedAtUptimeNs: 1_010_000_000,
        isKeyframe: false,
        nowUptimeNs: 1_020_000_000,
        config: backpressure
    )

    let stale = admission.decision(nowUptimeNs: 1_370_000_000, config: backpressure)
    #expect(!stale.shouldEncode)
    #expect(stale.holdReason == "stale-unacked")

    admission.noteKeyframeRequested()
    let requested = admission.decision(nowUptimeNs: 1_371_000_000, config: backpressure)

    #expect(requested.shouldEncode)
    #expect(requested.forceKeyframe)
    #expect(requested.keyframeReason == .clientRequest)
}
```

- [ ] **Step 4: Run the focused host tests and verify they fail before implementation**

Run:

```bash
swift test --package-path host --filter ScrollQualityTests
```

Expected before implementation: tests fail because stale abandonment still forces `.staleUnackedRecovery`.

## Task 2: Change Admission State Machine

**Files:**
- Modify: `host/AgentDeskHost/SharedTypes.swift`

- [ ] **Step 1: Remove stale recovery from keyframe reasons**

Change:

```swift
enum OwnedMediaKeyframeReason: String, Equatable, Sendable {
    case initial
    case periodic
    case clientRequest = "client-request"
    case postDrainRecovery = "post-drain-recovery"
    case staleUnackedRecovery = "stale-unacked-recovery"
}
```

to:

```swift
enum OwnedMediaKeyframeReason: String, Equatable, Sendable {
    case initial
    case periodic
    case clientRequest = "client-request"
    case postDrainRecovery = "post-drain-recovery"
}
```

- [ ] **Step 2: Remove stale pending state**

Delete `pendingStaleUnackedRecovery` from `OwnedMediaEncodeAdmission`.

In `noteSent`, remove:

```swift
pendingStaleUnackedRecovery = false
```

In `decision`, replace:

```swift
let forcedKeyframeReason: OwnedMediaKeyframeReason = pendingStaleUnackedRecovery ? .staleUnackedRecovery : .clientRequest
```

with:

```swift
let forcedKeyframeReason: OwnedMediaKeyframeReason = .clientRequest
```

- [ ] **Step 3: Rename the stale decision helper**

Rename:

```swift
private mutating func staleUnackedRecoveryDecision(
    nowUptimeNs: UInt64,
    config: OwnedMediaBackpressureConfig
) -> OwnedMediaAdmissionDecision?
```

to:

```swift
private mutating func staleUnackedAdmissionHoldDecision(
    nowUptimeNs: UInt64,
    config: OwnedMediaBackpressureConfig
) -> OwnedMediaAdmissionDecision?
```

Update the call site in `decision`:

```swift
if let staleHold = staleUnackedAdmissionHoldDecision(nowUptimeNs: nowUptimeNs, config: config) {
    return staleHold
}
```

- [ ] **Step 4: Make stale abandonment return hold, not keyframe**

Replace the bottom half of the stale helper with:

```swift
let staleIds = Set(staleFrames.map(\.key))
let abandonedBytes = staleFrames.reduce(0) { $0 + $1.value.bytes }
let oldestFrameId = staleFrames.first?.key
let abandonedInflightKeyframe = keyframeInFlightFrameId.map { staleIds.contains($0) } ?? false
unacknowledgedFrames = unacknowledgedFrames.filter { !staleIds.contains($0.key) }
if abandonedInflightKeyframe {
    keyframeInFlightFrameId = nil
}
refreshMode(config: config, nowUptimeNs: nowUptimeNs)

return OwnedMediaAdmissionDecision(
    shouldEncode: false,
    forceKeyframe: false,
    allowPeriodicKeyframe: false,
    mode: mode,
    holdReason: "stale-unacked",
    keyframeReason: nil,
    abandonedStaleUnackedCount: staleFrames.count,
    abandonedStaleUnackedBytes: abandonedBytes,
    abandonedStaleUnackedOldestFrameId: oldestFrameId
)
```

This intentionally does not set `pendingKeyframeRequest`. The latest raw capture mailbox keeps coalescing while admission waits for the next ACK or explicit client recovery.

- [ ] **Step 5: Run focused tests**

Run:

```bash
swift test --package-path host --filter ScrollQualityTests
```

Expected: stale admission tests pass, older stale recovery references fail only if any missed call sites remain.

## Task 3: Remove Stale Recovery Logging And Config Wording

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift`
- Modify: `.env.example`
- Modify: `SPEC.md`
- Modify: `TASKS.md`

- [ ] **Step 1: Remove stale recovery admitted log**

Delete this block from `noteAdmissionSent`:

```swift
if decision.keyframeReason == .staleUnackedRecovery && envelope.header.isKeyframe {
    logger.notice("owned media recovery-keyframe-admitted reason=stale-unacked frame=\(envelope.header.frameId, privacy: .public)")
}
```

Keep `logStaleUnackedAbandonment(_:)` unchanged.

- [ ] **Step 2: Update `.env.example` wording**

Change:

```bash
AGENTDESK_OWNED_MEDIA_STALE_UNACKED_MS=350              # abandon stale unacked frames and force one recovery keyframe
```

to:

```bash
AGENTDESK_OWNED_MEDIA_STALE_UNACKED_MS=350              # abandon stale unacked frames for admission accounting without forcing keyframe recovery
```

- [ ] **Step 3: Update current docs**

In `SPEC.md` and `TASKS.md`, replace current stale-unacked recovery wording with:

```markdown
Stale unacked owned-media frames are abandoned for admission accounting only. They do not force a keyframe. Keyframe recovery is reserved for decoder continuity failures, incomplete keyframes, malformed/auth failures, explicit client requests, and post-drain timeout recovery.
```

- [ ] **Step 4: Search for removed reason**

Run:

```bash
rg "staleUnackedRecovery|stale-unacked-recovery|recovery-keyframe-admitted" host client SPEC.md TASKS.md .env.example
```

Expected: no matches.

## Task 4: Full Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run full check**

Run:

```bash
just check
```

Expected: host and client builds and tests pass.

- [ ] **Step 2: Run attached-console physical iPhone check**

Run:

```bash
AGENTDESK_OWNED_MEDIA_CODEC=hevc \
AGENTDESK_OWNED_MEDIA_CHROMA=420 \
just fresh-consoled-run
```

Scroll for 20 to 30 seconds, then stop the console with Ctrl-C after the user says done.

- [ ] **Step 3: Summarize diagnostics**

Run:

```bash
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Expected differences from the bad run:

- `stale-unacked-abandoned` may still appear.
- `recovery-keyframe-admitted reason=stale-unacked` must not appear.
- Keyframe count should drop sharply during scroll.
- `postDrainRecovery` should only appear after drain timeout, not repeatedly after every stale ACK.
- Client `firstToCompleteMs` spikes should reduce because the host is no longer injecting 180-190KB recovery keyframes into congestion.

- [ ] **Step 4: Commit and push if green**

Run:

```bash
git status --short
git add host/AgentDeskHost/SharedTypes.swift host/AgentDeskHost/OwnedMediaTransport.swift host/AgentDeskHostTests/ScrollQualityTests.swift .env.example SPEC.md TASKS.md docs/superpowers/plans/2026-06-20-stale-unacked-admission.md
git commit -m "fix: stop stale owned media acks forcing keyframes"
git push origin main
```

Do not commit if `just check` fails or the physical run shows worse freeze behavior.

## Self-Review

- Spec coverage: The plan covers stale unacked host admission behavior, logging, tests, docs, and physical verification. It intentionally does not change codec, chroma, QUIC packet repair, pacing defaults, client renderer, WebRTC, or dual-plane code.
- Placeholder scan: No placeholder steps remain. Each code-changing task names exact files and snippets.
- Type consistency: The plan uses current types from `host/AgentDeskHost/SharedTypes.swift`: `OwnedMediaEncodeAdmission`, `OwnedMediaAdmissionDecision`, `OwnedMediaKeyframeReason`, and `OwnedMediaBackpressureConfig`.
