import Testing
@testable import AgentDeskHost

// ADR-0098: what a keyframe nobody asked for is allowed to cost.
//
// 25 of 53 keyframes in a measured 45-minute session were `requestedReason=none` -- the GOP
// timer, firing every 15.1s at 91-108KB. On the 300kbps link that was 51kbps, 17% of the whole
// budget, arriving as a lump every fifteen seconds. It was the largest single keyframe source
// and nothing in the system had an opinion about it.

private func encodingConfig() -> OwnedMediaEncodingConfiguration {
    OwnedMediaEncodingConfiguration(
        targetBitrateKbps: Config.ownedMediaBitrateKbps,
        expectedFrameRate: Config.ownedMediaExpectedFrameRate,
        keyframeIntervalFrames: Config.ownedMediaKeyframeIntervalFrames,
        keyframeMaxIntervalMs: Config.ownedMediaKeyframeMaxIntervalMs
    )
}

// A link at the ceiling keeps exactly the cadence it had. This arc is about the rungs below;
// retuning the top would be a change nobody asked for and no measurement supports.
@Test func keyframeIntervalIsUnchangedAtTheCeiling() {
    let interval = VideoToolboxOwnedMediaEncoder.keyframeInterval(
        forBitrateKbps: Config.ownedMediaBitrateKbps,
        configuration: encodingConfig()
    )
    #expect(interval.frames == Config.ownedMediaKeyframeIntervalFrames)
    #expect(interval.maxIntervalMs == Config.ownedMediaKeyframeMaxIntervalMs)
}

// The measured case. At the emergency rung the refresh stretches to the ceiling, taking the
// periodic tax from 17% of the budget to about 4%.
@Test func keyframeIntervalStretchesAtTheEmergencyRung() {
    let interval = VideoToolboxOwnedMediaEncoder.keyframeInterval(
        forBitrateKbps: Config.ownedMediaEmergencyBitrateKbps,
        configuration: encodingConfig()
    )
    #expect(interval.maxIntervalMs == Config.ownedMediaKeyframeMaxIntervalCeilingMs)
    #expect(interval.maxIntervalMs > Config.ownedMediaKeyframeMaxIntervalMs)
}

// Both properties move together, because "whichever comes first wins". At the emergency rung's
// 6fps the configured 120 frames is already 20s, so stretching only the duration would be inert
// -- the frame count would keep firing first and nothing would change.
@Test func theFrameCountStretchesWithTheDuration() {
    let interval = VideoToolboxOwnedMediaEncoder.keyframeInterval(
        forBitrateKbps: Config.ownedMediaEmergencyBitrateKbps,
        configuration: encodingConfig()
    )
    let framesAtEmergencyFps = interval.frames / max(1, Config.ownedMediaEmergencyFps)
    #expect(framesAtEmergencyFps * 1_000 >= interval.maxIntervalMs)
}

// A safety net with no bottom is not a net: a client that misses every explicit resync still has
// to come back on its own, so the stretch is bounded however slow the link gets.
@Test func theStretchIsBounded() {
    let interval = VideoToolboxOwnedMediaEncoder.keyframeInterval(
        forBitrateKbps: 1,
        configuration: encodingConfig()
    )
    #expect(interval.maxIntervalMs == Config.ownedMediaKeyframeMaxIntervalCeilingMs)
}

// It only ever stretches. A bitrate above the ceiling must not make the refresh MORE frequent
// than configured -- that would spend more of a link precisely when it is doing well.
@Test func aFastLinkNeverShortensTheInterval() {
    let interval = VideoToolboxOwnedMediaEncoder.keyframeInterval(
        forBitrateKbps: Config.ownedMediaBitrateKbps * 4,
        configuration: encodingConfig()
    )
    #expect(interval.frames == Config.ownedMediaKeyframeIntervalFrames)
    #expect(interval.maxIntervalMs == Config.ownedMediaKeyframeMaxIntervalMs)
}

// --- the adaptive handoff ---

private func ladderConfig() -> MediaQualityControllerConfig { .fromConfig() }

// The measured 223KB. Switching a stream pinned to 0.33 back to adaptive must not first jump the
// encoder to full resolution: resolution is the one axis whose change forces a true IDR.
@Test func adaptiveHandoffKeepsTheRunningResolution() {
    let manual = MediaQualityTarget(
        bitrateKbps: 1_250, fps: 6, resolutionScale: 0.33, rung: .native, reason: "manual-quality-fixed"
    )
    let handoff = MediaQualityController.adaptiveHandoffTarget(
        from: manual, config: ladderConfig(), reason: "adaptive-quality-enabled"
    )
    #expect(handoff.resolutionScale == manual.resolutionScale)
}

// And it lands on a real ladder rung, so the ladder can climb from there. Pinning the manual
// target verbatim would leave it at `.native` below the ceiling, where `recover` returns early
// and the bitrate could never come back.
@Test func adaptiveHandoffLandsOnARungThatCanClimb() {
    let manual = MediaQualityTarget(
        bitrateKbps: 1_250, fps: 6, resolutionScale: 0.33, rung: .native, reason: "manual-quality-fixed"
    )
    let handoff = MediaQualityController.adaptiveHandoffTarget(
        from: manual, config: ladderConfig(), reason: "adaptive-quality-enabled"
    )
    #expect(handoff.rung != .native)
    #expect(handoff.bitrateKbps == ladderConfig().emergencyKbps)
    #expect(handoff.fps == ladderConfig().emergencyFps)
}

// A stream already at full resolution hands off to the ceiling, which is both correct and the
// behaviour that existed before -- the change must not cost anything on a healthy link.
@Test func adaptiveHandoffFromFullResolutionTakesTheCeiling() {
    let manual = MediaQualityTarget(
        bitrateKbps: 900, fps: 30, resolutionScale: 1.0, rung: .native, reason: "manual-quality-fixed"
    )
    let handoff = MediaQualityController.adaptiveHandoffTarget(
        from: manual, config: ladderConfig(), reason: "adaptive-quality-enabled"
    )
    #expect(handoff.rung == .native)
    #expect(handoff.bitrateKbps == ladderConfig().ceilingKbps)
    #expect(handoff.resolutionScale == 1.0)
}

// The handoff can only keep or lower the encoder's ambition, never raise it. An off-ladder scale
// keeps its own value rather than being rounded up to the nearest rung's.
@Test func adaptiveHandoffNeverRaisesTheScale() {
    for scale in [0.9, 0.6, 0.4, 0.2] {
        let manual = MediaQualityTarget(
            bitrateKbps: 1_000, fps: 15, resolutionScale: scale, rung: .native, reason: "manual"
        )
        let handoff = MediaQualityController.adaptiveHandoffTarget(
            from: manual, config: ladderConfig(), reason: "adaptive-quality-enabled"
        )
        #expect(handoff.resolutionScale == scale)
    }
}
