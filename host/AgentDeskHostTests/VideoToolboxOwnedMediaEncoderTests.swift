import CoreVideo
import XCTest
@testable import AgentDeskHost

// Phase 1 of the mixed-mode renderer (ADR-0025): the host HEVC encoder produces a
// keyframe-then-delta envelope sequence, force-keyframes on demand, and stamps the
// wire refresh reason. The bytes are dropped here; the datagram carrier (Phase 2)
// is what sends them. These tests run hardware HEVC on the Mac test host.
final class VideoToolboxOwnedMediaEncoderTests: XCTestCase {
    private func makeFrame(frameIndex: UInt64, width: Int = 256, height: Int = 256) -> CapturedVideoFrame {
        var buffer: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:],
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &buffer
        )
        precondition(status == kCVReturnSuccess, "pixel buffer create failed")
        let pixelBuffer = buffer!
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        let base = CVPixelBufferGetBaseAddress(pixelBuffer)!
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let band = Int(frameIndex % 256)
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let offset = x * 4
                row[offset + 0] = UInt8((x + band) % 256)
                row[offset + 1] = UInt8((y + band) % 256)
                row[offset + 2] = UInt8((x + y + band) % 256)
                row[offset + 3] = 255
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: Int64(frameIndex) * 33_333_333,
            capturedAtUptimeNs: DispatchTime.now().uptimeNanoseconds,
            rotation: ._0
        )
    }

    private func config(keyframeInterval: Int) -> OwnedMediaEncodingConfiguration {
        OwnedMediaEncodingConfiguration(targetBitrateKbps: 2000, expectedFrameRate: 30, keyframeIntervalFrames: keyframeInterval)
    }

    private func updateId(_ frameId: UInt64) -> OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: frameId)
    }

    // Awaiting inside XCTUnwrap's autoclosure is rejected, so the await is split out.
    private func encodeFrame(
        _ encoder: VideoToolboxOwnedMediaEncoder,
        frameIndex: UInt64,
        frameId: UInt64,
        forceKeyframe: Bool = false,
        requestedKeyframeReason: OwnedMediaKeyframeReason? = nil
    ) async throws -> OwnedMediaFrameEnvelope {
        let envelope = await encoder.encode(
            makeFrame(frameIndex: frameIndex),
            updateId: updateId(frameId),
            forceKeyframe: forceKeyframe,
            requestedKeyframeReason: requestedKeyframeReason
        )
        return try XCTUnwrap(envelope, "encoder produced no frame for frameId \(frameId)")
    }

    func testFirstFrameIsKeyframeWithParameterSets() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
        defer { encoder.invalidate() }
        let frame = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        XCTAssertTrue(frame.header.isKeyframe)
        XCTAssertEqual(frame.header.codec, .hevc)
        XCTAssertEqual(frame.header.refreshReason, .initial)
        let parameterSets = try XCTUnwrap(frame.header.parameterSets, "keyframe carries no parameter sets")
        XCTAssertFalse(parameterSets.sps.isEmpty)
        XCTAssertFalse(parameterSets.pps.isEmpty)
        XCTAssertNotNil(parameterSets.vps, "HEVC parameter sets include a VPS")
        XCTAssertFalse(frame.payload.isEmpty)
    }

    func testEnvelopeRoundTripsThroughTheWire() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
        defer { encoder.invalidate() }
        let envelope = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        let decoded = try OwnedMediaFrameEnvelope.decode(envelope.encode())
        XCTAssertEqual(decoded.header, envelope.header)
        XCTAssertEqual(decoded.payload, envelope.payload)
    }

    func testSecondFrameIsDelta() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
        defer { encoder.invalidate() }
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        let second = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        XCTAssertFalse(second.header.isKeyframe, "second frame should be inter-predicted")
        XCTAssertNil(second.header.parameterSets, "delta frames carry no parameter sets")
        XCTAssertEqual(second.header.refreshReason, .rest)
    }

    func testPeriodicKeyframeFiresAtInterval() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 2))
        defer { encoder.invalidate() }
        // Frame 1 forced (first), frame 2 periodic (multiple of 2), frame 3 delta,
        // frame 4 periodic. Assert the cadence on frames 3 and 4.
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        _ = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        let third = try await encodeFrame(encoder, frameIndex: 2, frameId: 3)
        let fourth = try await encodeFrame(encoder, frameIndex: 3, frameId: 4)
        XCTAssertFalse(third.header.isKeyframe, "frame 3 is not on the keyframe interval")
        XCTAssertTrue(fourth.header.isKeyframe, "frame 4 is a periodic keyframe")
    }

    func testRequestKeyframeForcesTheNextFrame() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
        defer { encoder.invalidate() }
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        let second = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        XCTAssertFalse(second.header.isKeyframe)
        encoder.requestKeyframe()
        let third = try await encodeFrame(encoder, frameIndex: 2, frameId: 3)
        XCTAssertTrue(third.header.isKeyframe, "requestKeyframe must force the next frame to be a keyframe")
    }

    // ADR-0027 R83: the windowed ceiling is exactly `ratio` times the average
    // byte-rate (kbps * 1000 / 8) over a one-second window. This is the value set on
    // the session as kVTCompressionPropertyKey_DataRateLimits, so testing it tests
    // what the encoder caps to.
    func testDataRateLimitsCeilingTracksBitrateAndRatio() {
        let low = VideoToolboxOwnedMediaEncoder.dataRateLimits(targetBitrateKbps: 2000, ratio: 2.0)
        XCTAssertEqual(low.bytesPerWindow, 500_000, "2000 kbps = 250000 B/s, x2.0 over 1 s")
        XCTAssertEqual(low.windowSeconds, 1.0)
        let high = VideoToolboxOwnedMediaEncoder.dataRateLimits(targetBitrateKbps: 8000, ratio: 1.5)
        XCTAssertEqual(high.bytesPerWindow, 1_500_000, "8000 kbps = 1000000 B/s, x1.5 over 1 s")
    }

    // A forced keyframe is the burst the cap exists to bound. One full keyframe
    // interval of encoded bytes must fit the one-second window budget. (That the cap
    // *binds* on full-screen Retina content is device-validated in R91; the unit
    // guarantee is that the encoder accepts the property and never exceeds it.)
    func testForcedKeyframeStaysWithinDataRateCap() async throws {
        let ratio = 1.5
        let configuration = OwnedMediaEncodingConfiguration(
            targetBitrateKbps: 2000,
            expectedFrameRate: 30,
            keyframeIntervalFrames: 30,
            dataRateLimitRatio: ratio
        )
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: configuration)
        defer { encoder.invalidate() }
        let cap = VideoToolboxOwnedMediaEncoder.dataRateLimits(targetBitrateKbps: 2000, ratio: ratio).bytesPerWindow
        let first = try await encodeFrame(encoder, frameIndex: 0, frameId: 1, forceKeyframe: true)
        XCTAssertTrue(first.header.isKeyframe, "forced first frame is a keyframe")
        var total = first.payload.count
        for index in 1..<30 {
            let delta = try await encodeFrame(encoder, frameIndex: UInt64(index), frameId: UInt64(index + 1))
            total += delta.payload.count
        }
        XCTAssertLessThanOrEqual(Double(total), cap, "keyframe-interval bytes exceeded the DataRateLimits window cap")
    }

    // ADR-0033: the adaptive media-quality controller, pure-logic against fixed inputs.
    private func mediaQualityConfig() -> MediaQualityControllerConfig {
        MediaQualityControllerConfig(
            ceilingKbps: 2500, floorKbps: 800, survivalFloorKbps: 300,
            downStep: 0.7, upStep: 1.15,
            lossDownPermille: 50, raiseCleanWindows: 4, cadenceDownWindows: 2,
            fpsCeiling: 30, fpsFloor: 10,
            ackHoldP95Ms: 180, ackDownP95Ms: 350,
            cadenceGapMs: 500, freezeGapMs: 1_000, freezeFpsCeiling: 3,
            recoveryMaxGapMs: 300, recoveryMinFpsPermille: 800,
            transitionWarmupWindows: 1,
            capacity1Kbps: 650, capacity1Fps: 24, capacity1Scale: 0.75,
            capacity2Kbps: 400, capacity2Fps: 15, capacity2Scale: 0.5,
            emergencyKbps: 180, emergencyFps: 6, emergencyScale: 0.33,
            survivalScale: 0.5
        )
    }

    private func lossySample(ackP95Ms: Double? = nil) -> MediaQualitySample {
        MediaQualitySample(completedFrames: 80, expiredFrames: 20, ackAgeP95Ms: ackP95Ms)
    }

    private func cleanSample(ackP95Ms: Double? = nil) -> MediaQualitySample {
        MediaQualitySample(completedFrames: 100, expiredFrames: 0, ackAgeP50Ms: ackP95Ms, ackAgeP95Ms: ackP95Ms)
    }

    private func production(
        actualFps: Int = 30,
        targetFps: Int = 30,
        maxGapMs: Int = 33,
        sentKbps: Int = 2_000
    ) -> MediaProductionSummary {
        MediaProductionSummary(
            actualFps: actualFps,
            targetFps: targetFps,
            fpsDeficit: max(0, targetFps - actualFps),
            frames: max(1, actualFps),
            keyframes: 1,
            sentKbps: sentKbps,
            targetKbps: 2_500,
            maxGapMs: maxGapMs,
            resolutionScale: 1.0,
            windowMs: 1_000
        )
    }

    private func input(
        _ sample: MediaQualitySample,
        productionSummary: MediaProductionSummary? = nil,
        ackCount: Int = 1,
        staleRecoveryCount: Int = 0
    ) -> MediaQualityControllerInput {
        MediaQualityControllerInput(
            sample: sample,
            productionSummary: productionSummary,
            ackCount: ackCount,
            ackAgeMaxMs: sample.ackAgeP95Ms,
            staleRecoveryCount: staleRecoveryCount
        )
    }

    private func cleanInput(ackP95Ms: Double? = 50) -> MediaQualityControllerInput {
        input(cleanSample(ackP95Ms: ackP95Ms), productionSummary: production(), ackCount: ackP95Ms == nil ? 0 : 1)
    }

    private func lossInput(ackP95Ms: Double? = nil) -> MediaQualityControllerInput {
        input(lossySample(ackP95Ms: ackP95Ms), productionSummary: production(), ackCount: ackP95Ms == nil ? 0 : 1)
    }

    func testMediaQualityControllerSpendsBitrateBeforeResolution() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        XCTAssertEqual(controller.targetKbps, 2500, "starts at the ceiling")
        while controller.targetKbps > 800 {
            let outcome = controller.observe(lossInput()).outcome
            XCTAssertEqual(outcome.reason, "loss-down")
            XCTAssertFalse(outcome.fpsChanged)
            XCTAssertFalse(outcome.resolutionChanged)
            XCTAssertEqual(controller.targetFps, 30, "fps holds until normal bitrate floor")
            XCTAssertEqual(controller.targetResolutionScale, 1.0, "resolution holds until normal bitrate floor")
        }
        XCTAssertEqual(controller.targetKbps, 800)
        XCTAssertEqual(controller.targetFps, 30)
        XCTAssertEqual(controller.targetResolutionScale, 1.0)
    }

    func testMediaQualityControllerRaisesOnlyAfterCleanStreak() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let down = controller.observe(input(MediaQualitySample(completedFrames: 50, expiredFrames: 50), productionSummary: production())).outcome
        XCTAssertEqual(down.reason, "loss-down")
        let afterDown = controller.targetKbps
        XCTAssertLessThan(afterDown, 2500)
        XCTAssertFalse(controller.observe(cleanInput()).outcome.changed)
        XCTAssertFalse(controller.observe(cleanInput()).outcome.changed)
        XCTAssertFalse(controller.observe(cleanInput()).outcome.changed)
        XCTAssertEqual(controller.targetKbps, afterDown, "three clean windows do not raise; hysteresis needs four")
        let up = controller.observe(cleanInput()).outcome
        XCTAssertEqual(up.reason, "clean-up")
        XCTAssertGreaterThan(controller.targetKbps, afterDown)
    }

    func testMediaQualityControllerMissingProductionDoesNotResetRecoveryCredit() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let down = controller.observe(lossInput()).outcome
        XCTAssertEqual(down.reason, "loss-down")
        let afterDown = controller.targetKbps

        for index in 1...3 {
            let hold = controller.observe(cleanInput())
            XCTAssertEqual(hold.outcome.reason, "clean-hold")
            XCTAssertEqual(hold.recoveryStatus.cleanMs, index * 1_000)
        }

        let linkOnly = controller.observe(input(cleanSample(ackP95Ms: 50), ackCount: 1))
        XCTAssertEqual(linkOnly.outcome.reason, "recovery-wait-no-production")
        XCTAssertEqual(linkOnly.recoveryStatus.cleanMs, 3_000)
        XCTAssertEqual(controller.targetKbps, afterDown)

        let up = controller.observe(cleanInput())
        XCTAssertEqual(up.outcome.reason, "clean-up")
        XCTAssertGreaterThan(controller.targetKbps, afterDown)
    }

    func testMediaQualityControllerDoesNotRecoverFromAckOnlyWindows() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let down = controller.observe(lossInput()).outcome
        XCTAssertEqual(down.reason, "loss-down")
        let afterDown = controller.targetKbps

        for _ in 0..<8 {
            let decision = controller.observe(input(cleanSample(ackP95Ms: 50), ackCount: 1))
            XCTAssertEqual(decision.outcome.reason, "recovery-wait-no-production")
            XCTAssertFalse(decision.outcome.changed)
        }

        XCTAssertEqual(controller.targetKbps, afterDown)
    }

    func testMediaQualityControllerNeverExceedsCeiling() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.targetKbps, 2500, "clean windows cannot raise above the ceiling")
        XCTAssertEqual(controller.targetFps, 30)
        XCTAssertEqual(controller.targetResolutionScale, 1.0)
    }

    func testMediaQualityControllerIdleWindowHolds() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let outcome = controller.observe(input(MediaQualitySample(completedFrames: 0, expiredFrames: 0))).outcome
        XCTAssertFalse(outcome.changed)
        XCTAssertEqual(outcome.reason, "idle")
        XCTAssertEqual(controller.targetKbps, 2500)
        XCTAssertEqual(outcome.target.fps, 30, "fps holds at the ceiling on an idle window")
    }

    func testMediaQualityControllerIdleWindowBelowNativeAccruesRecovery() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        XCTAssertEqual(controller.target.rung, .emergency)

        let idle = input(MediaQualitySample(completedFrames: 0, expiredFrames: 0))
        let first = controller.observe(idle)
        XCTAssertEqual(first.outcome.reason, "clean-hold", "a calm window below native accrues recovery, not idle")
        XCTAssertEqual(first.recoveryStatus.cleanMs, 1_000)
        XCTAssertFalse(first.outcome.changed)
    }

    func testMediaQualityControllerIdleRecoversToNativeAtRest() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        XCTAssertEqual(controller.target.rung, .emergency)
        XCTAssertEqual(controller.targetResolutionScale, 0.33)

        // The screen settles: zero-activity, link-clean windows. The ladder climbs
        // back to native with no production to measure, so the next motion is crisp.
        let idle = input(MediaQualitySample(completedFrames: 0, expiredFrames: 0))
        var windows = 0
        while controller.target.rung != .native && windows < 400 {
            _ = controller.observe(idle)
            windows += 1
        }
        XCTAssertEqual(controller.target.rung, .native, "sustained rest climbs the ladder back to native")
        XCTAssertEqual(controller.targetResolutionScale, 1.0)
        XCTAssertEqual(controller.targetKbps, 2500)
        XCTAssertEqual(controller.targetFps, 30)
    }

    func testMediaQualityControllerInflightStallDoesNotClimbAtRest() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        XCTAssertEqual(controller.target.rung, .emergency)

        // Zero completions this window, but frames are still inflight: a pre-timeout
        // stall, not an idle screen. Recovery must not climb.
        let stall = MediaQualityControllerInput(
            sample: MediaQualitySample(completedFrames: 0, expiredFrames: 0),
            productionSummary: nil,
            ackCount: 0,
            ackAgeMaxMs: nil,
            inFlightFrames: 3,
            inFlightBytes: 90_000,
            oldestInflightMs: 1_200,
            staleRecoveryCount: 0
        )
        for _ in 0..<20 {
            let decision = controller.observe(stall)
            XCTAssertNotEqual(decision.outcome.reason, "clean-up")
            XCTAssertNotEqual(decision.outcome.reason, "probe-stable")
        }
        XCTAssertEqual(controller.target.rung, .emergency, "a stall must not be mistaken for idle recovery")
    }

    func testMediaQualityControllerStepsCapacityRungsAfterBitrateFloor() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        while controller.targetKbps > 800 {
            let outcome = controller.observe(lossInput()).outcome
            XCTAssertEqual(outcome.reason, "loss-down")
            XCTAssertEqual(controller.targetFps, 30, "fps holds while bitrate is still falling")
            XCTAssertFalse(outcome.fpsChanged)
        }
        let capacity1 = controller.observe(lossInput()).outcome
        XCTAssertEqual(capacity1.reason, "capacity-down")
        XCTAssertTrue(capacity1.resolutionChanged)
        XCTAssertEqual(controller.targetFps, 24)
        XCTAssertEqual(controller.targetKbps, 650)
        XCTAssertEqual(controller.targetResolutionScale, 0.75)
        let capacity2 = controller.observe(lossInput()).outcome
        XCTAssertEqual(capacity2.reason, "capacity-down")
        XCTAssertEqual(controller.targetFps, 15)
        XCTAssertEqual(controller.targetKbps, 400)
        XCTAssertEqual(controller.targetResolutionScale, 0.5)
        let survival = controller.observe(lossInput()).outcome
        XCTAssertEqual(survival.reason, "survival-down")
        XCTAssertEqual(controller.targetFps, 10, "cadence converges to the fps floor and not below")
        XCTAssertEqual(controller.targetKbps, 300, "survival bitrate converges to the survival floor and not below")
        XCTAssertEqual(controller.targetResolutionScale, 0.5)
        let emergency = controller.observe(lossInput()).outcome
        XCTAssertEqual(emergency.reason, "emergency-down")
        XCTAssertEqual(controller.targetFps, 6)
        XCTAssertEqual(controller.targetKbps, 180)
        XCTAssertEqual(controller.targetResolutionScale, 0.33)
    }

    func testMediaQualityControllerRecoversBitrateThenProbesResolutionThenFps() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        XCTAssertEqual(controller.targetKbps, 180)
        XCTAssertEqual(controller.targetFps, 6)
        XCTAssertEqual(controller.targetResolutionScale, 0.33)
        while controller.targetKbps < 300 {
            for _ in 0..<3 {
                let hold = controller.observe(cleanInput()).outcome
                XCTAssertFalse(hold.changed)
                XCTAssertFalse(hold.fpsChanged)
            }
            let outcome = controller.observe(cleanInput()).outcome
            if outcome.changed {
                XCTAssertEqual(outcome.reason, "clean-up")
                XCTAssertEqual(controller.targetFps, 6, "fps holds while emergency bitrate recovers")
                XCTAssertEqual(controller.targetResolutionScale, 0.33, "resolution holds while emergency bitrate recovers")
                XCTAssertLessThanOrEqual(controller.targetKbps, 300)
            }
        }
        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.targetKbps, 300)
        XCTAssertEqual(controller.targetFps, 6, "fps holds while the higher survival resolution is probed")
        XCTAssertEqual(controller.targetResolutionScale, 0.5)
        XCTAssertEqual(controller.target.rung, .survival)
        XCTAssertEqual(controller.target.reason, "quality-up")
        XCTAssertEqual(controller.currentRecoveryStatus.phase, .resolutionProbe)

        let warmup = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 3, targetFps: 6, maxGapMs: 780)
        ))
        XCTAssertFalse(warmup.outcome.changed, "resolution restart warmup does not immediately undo the probe")
        XCTAssertEqual(warmup.outcome.reason, "transition-warmup")
        XCTAssertEqual(warmup.recoveryStatus.phase, .transitionWarmup)
        XCTAssertEqual(controller.targetFps, 6)
        XCTAssertEqual(controller.targetResolutionScale, 0.5)

        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.targetFps, 6, "resolution probe must be proven stable before FPS changes")
        XCTAssertEqual(controller.currentRecoveryStatus.phase, .steady)

        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.targetFps, 10, "fps changes only after the higher resolution is stable")
        XCTAssertEqual(controller.targetResolutionScale, 0.5)
        XCTAssertEqual(controller.currentRecoveryStatus.phase, .fpsProbe)

        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.currentRecoveryStatus.phase, .steady)
        while controller.targetKbps < 400 {
            for _ in 0..<3 { _ = controller.observe(cleanInput()) }
            let outcome = controller.observe(cleanInput()).outcome
            if outcome.changed {
                XCTAssertEqual(outcome.reason, "clean-up")
                XCTAssertEqual(controller.targetFps, 10, "fps holds while survival bitrate recovers")
                XCTAssertEqual(controller.targetResolutionScale, 0.5, "resolution holds while survival bitrate recovers")
            }
        }
        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.targetKbps, 400)
        XCTAssertEqual(controller.targetFps, 15, "fps changes only after bitrate reaches the next rung")
        XCTAssertEqual(controller.targetResolutionScale, 0.5)
        var recoveryWindows = 0
        while controller.targetKbps < 2_500 && recoveryWindows < 240 {
            _ = controller.observe(cleanInput())
            recoveryWindows += 1
        }
        XCTAssertEqual(controller.targetFps, 30, "cadence recovers to the ceiling and not above")
        XCTAssertEqual(controller.targetKbps, 2500)
        XCTAssertEqual(controller.targetResolutionScale, 1.0)
    }

    func testMediaQualityControllerResolutionProbeRollsBackAfterWarmupFailure() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        while controller.targetKbps < 300 {
            for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        }
        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.target.rung, .survival)
        XCTAssertEqual(controller.targetFps, 6)
        XCTAssertEqual(controller.targetResolutionScale, 0.5)

        _ = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 3, targetFps: 6, maxGapMs: 780)
        ))
        let failedProbe = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 3, targetFps: 6, maxGapMs: 780)
        ))

        XCTAssertEqual(failedProbe.outcome.reason, "probe-resolution-rollback")
        XCTAssertEqual(failedProbe.outcome.target.rung, .emergency)
        XCTAssertEqual(failedProbe.outcome.target.bitrateKbps, 300)
        XCTAssertEqual(failedProbe.outcome.target.fps, 6)
        XCTAssertEqual(failedProbe.outcome.target.resolutionScale, 0.33)
    }

    func testMediaQualityControllerFpsProbeRollsBackOnlyFps() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        while controller.targetKbps < 300 {
            for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        }
        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        _ = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 3, targetFps: 6, maxGapMs: 780)
        ))
        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        for _ in 0..<4 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.targetFps, 10)
        XCTAssertEqual(controller.targetResolutionScale, 0.5)

        let failedFpsProbe = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 3, targetFps: 10, maxGapMs: 780)
        ))

        XCTAssertEqual(failedFpsProbe.outcome.reason, "probe-fps-rollback")
        XCTAssertEqual(failedFpsProbe.outcome.target.rung, .survival)
        XCTAssertEqual(failedFpsProbe.outcome.target.bitrateKbps, 300)
        XCTAssertEqual(failedFpsProbe.outcome.target.fps, 6)
        XCTAssertEqual(failedFpsProbe.outcome.target.resolutionScale, 0.5)
    }

    func testMediaQualityControllerLatencyHoldsWithoutLossAndDownshiftsWithLoss() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let highLatencyOnly = controller.observe(cleanInput(ackP95Ms: 600)).outcome
        XCTAssertFalse(highLatencyOnly.changed)
        XCTAssertEqual(highLatencyOnly.reason, "latency-hold")

        let highLatencyWithLoss = controller.observe(lossInput(ackP95Ms: 600)).outcome
        XCTAssertTrue(highLatencyWithLoss.changed)
        XCTAssertEqual(highLatencyWithLoss.reason, "loss-down")
    }

    func testMediaQualityControllerCadencePressureDownshiftsAfterSustainedWindows() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let slow = input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 10, targetFps: 30, maxGapMs: 650)
        )

        let first = controller.observe(slow)
        XCTAssertFalse(first.outcome.changed)
        XCTAssertTrue(first.signals.cadencePressure)
        XCTAssertEqual(first.outcome.reason, "cadence-hold")

        let second = controller.observe(slow)
        XCTAssertTrue(second.outcome.resolutionChanged)
        XCTAssertEqual(second.outcome.target.rung, .capacity1)
        XCTAssertEqual(second.outcome.reason, "cadence-capacity-down")
    }

    func testMediaQualityControllerQueueAndCadencePressureDownshiftsImmediately() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let slowQueued = input(
            cleanSample(ackP95Ms: 600),
            productionSummary: production(actualFps: 12, targetFps: 30, maxGapMs: 700)
        )

        let decision = controller.observe(slowQueued)

        XCTAssertTrue(decision.signals.queuePressure)
        XCTAssertTrue(decision.signals.cadencePressure)
        XCTAssertEqual(decision.outcome.target.rung, .capacity1)
        XCTAssertEqual(decision.outcome.reason, "queue-cadence-down")
    }

    func testMediaQualityControllerStaleRecoveryDownshiftsImmediately() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let stale = input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(),
            staleRecoveryCount: 1
        )

        let decision = controller.observe(stale)

        XCTAssertTrue(decision.signals.stalePressure)
        XCTAssertEqual(decision.outcome.target.rung, .capacity1)
        XCTAssertEqual(decision.outcome.reason, "stale-capacity-down")
    }

    func testMediaQualityControllerFreezeSkipsBitrateOnlyLossControl() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let frozen = input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 1, targetFps: 30, maxGapMs: 1_250)
        )

        let decision = controller.observe(frozen)

        XCTAssertTrue(decision.signals.freezePressure)
        XCTAssertEqual(decision.outcome.target.rung, .capacity1)
        XCTAssertEqual(decision.outcome.target.bitrateKbps, 650)
        XCTAssertEqual(decision.outcome.target.resolutionScale, 0.75)
        XCTAssertEqual(decision.outcome.reason, "freeze-capacity-down")
    }

    func testMediaQualityControllerSurvivalFreezeEntersEmergency() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        _ = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 1, targetFps: 30, maxGapMs: 1_250)
        ))
        _ = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 1, targetFps: 24, maxGapMs: 1_250)
        ))
        _ = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 1, targetFps: 15, maxGapMs: 1_250)
        ))
        XCTAssertEqual(controller.targetFps, 10)
        XCTAssertEqual(controller.targetResolutionScale, 0.5)

        let emergency = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 1, targetFps: 10, maxGapMs: 1_250)
        ))

        XCTAssertEqual(emergency.outcome.target.rung, .emergency)
        XCTAssertEqual(emergency.outcome.reason, "emergency-down")
        XCTAssertEqual(emergency.outcome.target.fps, 6)
        XCTAssertEqual(emergency.outcome.target.bitrateKbps, 180)
        XCTAssertEqual(emergency.outcome.target.resolutionScale, 0.33)
    }

    func testMediaQualityControllerDoesNotRecoverWhileCadenceIsBad() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        _ = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 1, targetFps: 30, maxGapMs: 1_250)
        ))
        XCTAssertEqual(controller.targetResolutionScale, 0.75)
        let badCadence = input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 12, targetFps: 24, maxGapMs: 700)
        )

        for _ in 0..<8 {
            let decision = controller.observe(badCadence)
            XCTAssertNotEqual(decision.outcome.reason, "quality-up")
        }

        XCTAssertLessThan(controller.targetResolutionScale, 1.0)
    }

    func testMediaQualityControllerBadCadenceResetsRecoveryCredit() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        _ = controller.observe(lossInput())

        for _ in 0..<3 { _ = controller.observe(cleanInput()) }
        let badCadence = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 10, targetFps: 30, maxGapMs: 650)
        ))
        XCTAssertEqual(badCadence.recoveryStatus.cleanMs, 0)
        XCTAssertEqual(badCadence.recoveryStatus.blocker, "cadence-pressure")

        for _ in 0..<3 {
            let hold = controller.observe(cleanInput())
            XCTAssertEqual(hold.outcome.reason, "clean-hold")
        }
        XCTAssertLessThan(controller.targetKbps, 2500)
    }

    func testMediaQualityControllerProbeCadenceFailureDownshiftsImmediately() {
        let config = MediaQualityControllerConfig(
            ceilingKbps: 2500, floorKbps: 800, survivalFloorKbps: 300,
            downStep: 0.7, upStep: 10.0,
            lossDownPermille: 50, raiseCleanWindows: 1, cadenceDownWindows: 4,
            fpsCeiling: 30, fpsFloor: 10,
            ackHoldP95Ms: 180, ackDownP95Ms: 350,
            cadenceGapMs: 500, freezeGapMs: 1_000, freezeFpsCeiling: 3,
            recoveryMaxGapMs: 300, recoveryMinFpsPermille: 800,
            transitionWarmupWindows: 0,
            capacity1Kbps: 650, capacity1Fps: 24, capacity1Scale: 0.75,
            capacity2Kbps: 400, capacity2Fps: 15, capacity2Scale: 0.5,
            emergencyKbps: 180, emergencyFps: 6, emergencyScale: 0.33,
            survivalScale: 0.5
        )
        var controller = MediaQualityController(config: config)
        _ = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 1, targetFps: 30, maxGapMs: 1_250)
        ))
        XCTAssertEqual(controller.targetResolutionScale, 0.75)

        let bitrateUp = controller.observe(cleanInput())
        XCTAssertEqual(bitrateUp.outcome.reason, "clean-up")
        XCTAssertEqual(controller.targetResolutionScale, 0.75)
        let up = controller.observe(cleanInput())
        XCTAssertEqual(up.outcome.reason, "quality-up")
        XCTAssertEqual(controller.targetResolutionScale, 1.0)

        let failedProbe = controller.observe(input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(actualFps: 10, targetFps: 24, maxGapMs: 650)
        ))
        XCTAssertEqual(failedProbe.outcome.reason, "probe-resolution-rollback")
        XCTAssertEqual(failedProbe.outcome.target.rung, .capacity1)
        XCTAssertEqual(failedProbe.recoveryStatus.blocker, "probe-resolution-pressure")
    }

    func testMediaQualityControllerConfigNormalizesSurvivalKnobs() {
        let config = MediaQualityControllerConfig(
            ceilingKbps: 2500, floorKbps: 800, survivalFloorKbps: 1200,
            downStep: 1.5, upStep: 0.5,
            lossDownPermille: 0, raiseCleanWindows: 0, cadenceDownWindows: 0,
            fpsCeiling: 30, fpsFloor: 60,
            ackHoldP95Ms: 0, ackDownP95Ms: 0,
            cadenceGapMs: 0, freezeGapMs: 0, freezeFpsCeiling: 0,
            recoveryMaxGapMs: 0, recoveryMinFpsPermille: 2_000,
            transitionWarmupWindows: -1,
            capacity1Kbps: 900, capacity1Fps: 60, capacity1Scale: 2,
            capacity2Kbps: 700, capacity2Fps: 40, capacity2Scale: 0.8,
            emergencyKbps: 500, emergencyFps: 40, emergencyScale: 0.9,
            survivalScale: 0.9
        )
        XCTAssertEqual(config.survivalFloorKbps, 800, "survival floor cannot exceed the normal bitrate floor")
        XCTAssertLessThan(config.downStep, 1.0, "down step must stay a down step")
        XCTAssertGreaterThan(config.upStep, 1.0, "up step must stay an up step")
        XCTAssertEqual(config.cadenceDownWindows, 1)
        XCTAssertEqual(config.fpsFloor, 30, "fps floor cannot exceed the fps ceiling")
        XCTAssertEqual(config.freezeGapMs, config.cadenceGapMs)
        XCTAssertEqual(config.recoveryMinFpsPermille, 1_000)
        XCTAssertEqual(config.transitionWarmupWindows, 0)
        XCTAssertEqual(config.capacity1Kbps, 800)
        XCTAssertEqual(config.capacity1Fps, 30)
        XCTAssertEqual(config.capacity1Scale, 1.0)
        XCTAssertEqual(config.capacity2Scale, 0.8)
        XCTAssertEqual(config.survivalScale, 0.8)
        XCTAssertEqual(config.emergencyKbps, 500)
        XCTAssertEqual(config.emergencyFps, 30)
        XCTAssertEqual(config.emergencyScale, 0.8)
    }

    func testMediaStateReturnsCapacityRetryUntilIntervalElapses() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        while controller.targetFps > 15 {
            _ = controller.observe(lossInput())
        }
        XCTAssertEqual(controller.targetFps, 15)

        var state = QuicSessionHostMediaState(
            expectedFrameRate: 30,
            qualityController: controller,
            retryIntervalNs: 50_000_000,
            staleInflightTimeoutNs: 500_000_000
        )

        let firstAdmission = state.reserveUpdateId(nowNs: 1_000_000_000)
        guard case .ready(let firstUpdateId) = firstAdmission else {
            return XCTFail("expected first frame admission to succeed")
        }
        XCTAssertEqual(firstUpdateId.frameId, 1)

        let secondAdmission = state.reserveUpdateId(nowNs: 1_030_000_000)
        guard case .retry(let afterNs, let reason) = secondAdmission else {
            return XCTFail("expected capacity retry while cadence gate is active")
        }
        XCTAssertEqual(reason, .capacity)
        XCTAssertGreaterThan(afterNs, 0)
        XCTAssertLessThanOrEqual(afterNs, 40_000_000)

        let thirdAdmission = state.reserveUpdateId(nowNs: 1_067_000_000)
        guard case .ready(let secondUpdateId) = thirdAdmission else {
            return XCTFail("expected admission after capacity interval elapsed")
        }
        XCTAssertEqual(secondUpdateId.frameId, 2)
    }

    func testMediaStateRecoversStaleInflightBackpressureWithoutForcedKeyframe() {
        var state = QuicSessionHostMediaState(
            maxInflightFrames: 1,
            maxInflightBytes: 10_000,
            expectedFrameRate: 30,
            retryIntervalNs: 50_000_000,
            staleInflightTimeoutNs: 200_000_000
        )

        let firstAdmission = state.reserveUpdateId(nowNs: 1_000_000_000)
        guard case .ready(let firstUpdateId) = firstAdmission else {
            return XCTFail("expected first frame admission to succeed")
        }
        state.noteSent(
            frameId: firstUpdateId.frameId,
            encodedBytes: 2_000,
            packets: [],
            sentAtUptimeNs: 1_000_000_000
        )

        let blockedAdmission = state.reserveUpdateId(nowNs: 1_050_000_000)
        guard case .retry(let afterNs, let reason) = blockedAdmission else {
            return XCTFail("expected backpressure retry while in-flight frame is fresh")
        }
        XCTAssertEqual(reason, .backpressure)
        XCTAssertEqual(afterNs, 50_000_000)
        XCTAssertFalse(state.takeClientKeyframeRequest())

        let recoveredAdmission = state.reserveUpdateId(nowNs: 1_250_000_000)
        guard case .ready(let recoveredUpdateId) = recoveredAdmission else {
            return XCTFail("expected stale in-flight recovery to reopen admission")
        }
        XCTAssertEqual(recoveredUpdateId.frameId, 2)
        XCTAssertFalse(state.takeClientKeyframeRequest(), "stale admission recovery is pressure, not decoder recovery")
    }

    func testMediaStateCoalescesClientKeyframeRequestsWhileKeyframeIsInflight() {
        var state = QuicSessionHostMediaState(
            maxInflightFrames: 2,
            maxInflightBytes: 200_000,
            expectedFrameRate: 30,
            retryIntervalNs: 50_000_000,
            staleInflightTimeoutNs: 200_000_000
        )

        XCTAssertEqual(state.noteKeyframeRequest(), .queued)
        XCTAssertTrue(state.takeClientKeyframeRequest())
        XCTAssertFalse(state.takeClientKeyframeRequest(), "client keyframe request is one-shot")

        state.noteSent(frameId: 1, encodedBytes: 60_000, packets: [], isKeyframe: true, sentAtUptimeNs: 1_000_000_000)
        XCTAssertEqual(state.noteKeyframeRequest(), .suppressedInFlight(frameId: 1))
        XCTAssertFalse(state.takeClientKeyframeRequest())

        _ = state.noteAck(frameId: 1, nowNs: 1_050_000_000)
        XCTAssertEqual(state.noteKeyframeRequest(), .queued)
        XCTAssertTrue(state.takeClientKeyframeRequest())
    }

    func testClientRequestKeyframeMarksReset() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
        defer { encoder.invalidate() }
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        _ = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        let forced = try await encodeFrame(
            encoder, frameIndex: 2, frameId: 3,
            forceKeyframe: true, requestedKeyframeReason: .clientRequest
        )
        XCTAssertTrue(forced.header.isKeyframe)
        XCTAssertEqual(forced.header.refreshReason, .reset, "a client-requested keyframe is a reset refresh")
    }
}
