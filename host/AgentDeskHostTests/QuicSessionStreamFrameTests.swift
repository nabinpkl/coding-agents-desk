import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct QuicSessionStreamFrameTests {
    @Test func quicSessionFrameRoundTripsRoleAndPayload() throws {
        let payload = Data(#"{"t":"input-event"}"#.utf8)
        let encoded = try QuicSessionStreamFrame.encode(role: .input, payload: payload)
        let decoded = try QuicSessionStreamFrame.decode(encoded)

        #expect(decoded.role == .input)
        #expect(decoded.payload == payload)
        #expect(encoded[encoded.startIndex] == QuicSessionStreamRole.input.rawValue)
        #expect(try encoded.readUInt32BE(at: 1) == UInt32(payload.count))
    }

    @Test func quicSessionFrameRejectsMalformedFrames() throws {
        #expect(throws: QuicSessionFrameError.malformed) {
            _ = try QuicSessionStreamFrame.decode(Data())
        }

        #expect(throws: QuicSessionFrameError.malformed) {
            _ = try QuicSessionStreamFrame.decode(Data([0xff, 0, 0, 0, 0]))
        }

        let shortPayload = Data([QuicSessionStreamRole.control.rawValue, 0, 0, 0, 2, 0xaa])
        #expect(throws: QuicSessionFrameError.malformed) {
            _ = try QuicSessionStreamFrame.decode(shortPayload)
        }
    }

    @Test func quicSessionFrameRejectsOversizedPayloads() throws {
        let payload = Data(repeating: 0xab, count: QuicSessionStreamFrame.maxFrameLength + 1)

        #expect(throws: QuicSessionFrameError.frameTooLarge) {
            _ = try QuicSessionStreamFrame.encode(role: .control, payload: payload)
        }
    }

    @Test func filesRoleUsesItsDocumentBudgetWithoutRaisingOtherLaneLimits() throws {
        let payload = Data(repeating: 0xab, count: QuicSessionStreamFrame.maxFrameLength + 1)
        let encoded = try QuicSessionStreamFrame.encode(role: .files, payload: payload)
        #expect(try QuicSessionStreamFrame.decode(encoded).payload == payload)
        #expect(QuicSessionStreamFrame.maxFrameLength(for: .input) == QuicSessionStreamFrame.maxFrameLength)
        #expect(QuicSessionStreamFrame.maxFrameLength(for: .files) == WorkspaceLaneCodec.maximumFrameBytes)
    }

    @Test func streamRoleBytesArePinned() {
        #expect(QuicSessionStreamRole.control.rawValue == 1)
        #expect(QuicSessionStreamRole.input.rawValue == 2)
        #expect(QuicSessionStreamRole.graphics.rawValue == 3)
        #expect(QuicSessionStreamRole.dom.rawValue == 4)
        #expect(QuicSessionStreamRole.terminal.rawValue == 5)
        #expect(QuicSessionStreamRole.files.rawValue == 6)
        #expect(QuicSessionStreamRole(rawValue: 1) == .control)
        #expect(QuicSessionStreamRole(rawValue: 2) == .input)
        #expect(QuicSessionStreamRole(rawValue: 3) == .graphics)
        #expect(QuicSessionStreamRole(rawValue: 4) == .dom)
        #expect(QuicSessionStreamRole(rawValue: 5) == .terminal)
        #expect(QuicSessionStreamRole(rawValue: 6) == .files)
        #expect(QuicSessionStreamRole(rawValue: 7) == .voice)
    }

    @Test func quicSessionFrameRoundTripsDomRole() throws {
        let payload = Data(#"{"t":"dom-batch","tb":3,"co":true,"ev":[]}"#.utf8)
        let encoded = try QuicSessionStreamFrame.encode(role: .dom, payload: payload)
        let decoded = try QuicSessionStreamFrame.decode(encoded)

        #expect(decoded.role == .dom)
        #expect(decoded.payload == payload)
        #expect(encoded[encoded.startIndex] == QuicSessionStreamRole.dom.rawValue)
    }

    @Test func quicSessionFrameRoundTripsTerminalRole() throws {
        let payload = Data([0x08, 0x01, 0x12, 0x04, 0x68, 0x6f, 0x6d, 0x65])
        let encoded = try QuicSessionStreamFrame.encode(role: .terminal, payload: payload)
        let decoded = try QuicSessionStreamFrame.decode(encoded)

        #expect(decoded.role == .terminal)
        #expect(decoded.payload == payload)
        #expect(encoded[encoded.startIndex] == QuicSessionStreamRole.terminal.rawValue)
    }

    @Test func domBatchEnvelopeRoundTripsWithCompactKeys() throws {
        let envelope = DomBatchEnvelope(tabId: 7, checkout: true)
        let data = try JSONEncoder().encode(envelope)
        let decoded = try JSONDecoder().decode(DomBatchEnvelope.self, from: data)
        let json = String(data: data, encoding: .utf8) ?? ""

        #expect(decoded == envelope)
        #expect(decoded.type == "dom-batch")
        #expect(json.contains("\"t\":\"dom-batch\""))
        #expect(json.contains("\"tb\":7"))
        #expect(json.contains("\"co\":true"))
    }

    @Test func domBatchEnvelopeDecodeIgnoresEventsArray() throws {
        // The shim sends the rrweb events under "ev"; the host models only the envelope and
        // forwards the events opaquely, so decoding must tolerate (and drop) the unlisted key.
        let wire = Data(#"{"t":"dom-batch","tb":2,"co":false,"ev":[{"type":4},{"type":2}]}"#.utf8)
        let decoded = try JSONDecoder().decode(DomBatchEnvelope.self, from: wire)

        #expect(decoded.tabId == 2)
        #expect(decoded.checkout == false)
        #expect(decoded.type == "dom-batch")
    }

    @Test func domInputCommandRoundTripsWithCompactKeys() throws {
        let cmd = DomInputCommand(x: 100.5, y: 60)
        let data = try JSONEncoder().encode(cmd)
        let decoded = try JSONDecoder().decode(DomInputCommand.self, from: data)
        let json = String(data: data, encoding: .utf8) ?? ""

        #expect(decoded == cmd)
        #expect(decoded.type == "dom-input")
        #expect(decoded.kind == "mouse")
        #expect(json.contains("\"t\":\"dom-input\""))
        #expect(json.contains("\"k\":\"mouse\""))
        #expect(json.contains("\"x\":100.5"))
    }

    @Test func domMirrorFlagDefaultsOff() {
        // ADR-0038: the whole DOM-mirror subsystem is gated off by default. Verify the flag's
        // default hermetically (empty environment), and that an explicit opt-in flips it.
        #expect(Config.enabledFlag(
            environmentKey: "AGENTDESK_DOM_MIRROR_ENABLED",
            defaultValue: false,
            environment: [:]
        ) == false)
        #expect(Config.enabledFlag(
            environmentKey: "AGENTDESK_DOM_MIRROR_ENABLED",
            defaultValue: false,
            environment: ["AGENTDESK_DOM_MIRROR_ENABLED": "1"]
        ) == true)
    }

    @Test func autoApprovePairingRequiresDevIterationRun() {
        #expect(Config.autoApprovePairingEnabled(environment: [:]) == false)
        #expect(Config.autoApprovePairingEnabled(environment: [
            "AGENTDESK_AUTO_APPROVE": "1"
        ]) == false)
        #expect(Config.autoApprovePairingEnabled(environment: [
            "AGENTDESK_DEV_ITERATION_RUN": "1"
        ]) == false)
        #expect(Config.autoApprovePairingEnabled(environment: [
            "AGENTDESK_AUTO_APPROVE": "1",
            "AGENTDESK_DEV_ITERATION_RUN": "1"
        ]) == true)
    }

    @Test func agentTerminalTombstoneLimitUsesPositiveEnvironmentValueOrDefault() {
        #expect(Config.positiveInt(
            environment: ["AGENTDESK_AGENT_TERMINAL_TOMBSTONE_LIMIT": "17"],
            environmentKey: "AGENTDESK_AGENT_TERMINAL_TOMBSTONE_LIMIT",
            defaultValue: 256
        ) == 17)
        #expect(Config.positiveInt(
            environment: ["AGENTDESK_AGENT_TERMINAL_TOMBSTONE_LIMIT": "0"],
            environmentKey: "AGENTDESK_AGENT_TERMINAL_TOMBSTONE_LIMIT",
            defaultValue: 256
        ) == 256)
        #expect(Config.agentTerminalRequestTombstoneLimit > 0)
    }

    @Test func sessionReadyCarriesResumeAndMediaKeySalt() throws {
        let ready = SessionReady(
            sessionId: "session-123",
            resumeId: Data([1, 2, 3]),
            resumeSecret: Data([7, 8, 9]),
            resumeExpiresAt: 1_800_000_020,
            mediaKeySalt: Data([4, 5, 6]),
            hostSignature: Data([10, 11, 12])
        )

        let data = try JSONEncoder().encode(ready)
        let decoded = try JSONDecoder().decode(SessionReady.self, from: data)
        let json = String(data: data, encoding: .utf8) ?? ""

        #expect(decoded == ready)
        #expect(json.contains("\"t\":\"session-ready\""))
        #expect(json.contains("\"sid\":\"session-123\""))
        #expect(json.contains("\"rid\":\"AQID\""))
        #expect(json.contains("\"rs\":\"BwgJ\""))
        #expect(json.contains("\"mk\":\"BAUG\""))
        #expect(json.contains("\"hs\":\"CgsM\""))
    }

    @Test func sessionResumeChallengeAndProofRoundTripWithCompactKeys() throws {
        let resume = SessionResumeInit(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123",
            resumeId: Data([1, 2, 3]),
            clientNonce: Data([4, 5, 6]),
            protocolVersion: 3
        )
        let challenge = SessionResumeChallenge(
            hostNonce: Data([7, 8, 9]),
            resumeExpiresAt: 1_800_000_020,
            hostSignature: Data([13, 14, 15])
        )
        let proof = SessionResumeProof(proof: Data([10, 11, 12]))

        let resumeData = try JSONEncoder().encode(resume)
        let challengeData = try JSONEncoder().encode(challenge)
        let proofData = try JSONEncoder().encode(proof)
        let decoded = try JSONDecoder().decode(SessionResumeInit.self, from: resumeData)
        let challengeDecoded = try JSONDecoder().decode(SessionResumeChallenge.self, from: challengeData)
        let proofDecoded = try JSONDecoder().decode(SessionResumeProof.self, from: proofData)
        let json = String(data: resumeData, encoding: .utf8) ?? ""

        #expect(decoded == resume)
        #expect(challengeDecoded == challenge)
        #expect(proofDecoded == proof)
        #expect(json.contains("\"t\":\"session-resume\""))
        #expect(json.contains("\"rid\":\"AQID\""))
        #expect(!json.contains("BwgJ"))
        #expect(decoded.deviceFingerprint == DeviceFingerprint("device-fp"))
        #expect(decoded.protocolVersion == 3)
    }

    @Test func sessionResumeProofRejectsUnexpectedType() {
        let data = Data(#"{"t":"session-ready","p":"AQID"}"#.utf8)

        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(SessionResumeProof.self, from: data)
        }
    }

    @Test func inputEventFrameRoundTripsThroughCodable() throws {
        let event = NormalizedInput.key(code: "ansi-A", modifiers: [.cmd, .shift])
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)

        #expect(decoded == frame)
        #expect(decoded.type == "input-event")
        #expect(decoded.event == event)
        #expect(decoded.cursorRevision == nil)
    }

    @Test func cursorSetInputEventFrameRoundTripsThroughCodable() throws {
        let event = NormalizedInput.cursorSet(displayId: "display-a", x: 250.5, y: 500.75)
        let frame = InputChannelEvent(event: event, cursorRevision: 11)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)

        #expect(decoded.event == event)
        #expect(decoded.cursorRevision == 11)
    }

    @Test func protocolVersionIsSeventeenForLiveAgentSessions() {
        #expect(Config.protocolVersion == 17)
        #expect(Config.minCompatibleProtocolVersion == 17)
    }

    @available(macOS 26.0, *)
    @Test func productionDiagnosticsPublishesActualFpsAgainstTargetFps() {
        var tracker = MediaProductionDiagnosticsTracker(
            publishIntervalNs: 1_000_000_000
        )

        #expect(tracker.noteSent(
            bytes: 125_000,
            isKeyframe: true,
            targetKbps: 2_500,
            targetFps: 30,
            resolutionScale: 1.0,
            nowNs: 0
        ) == nil)
        #expect(tracker.noteSent(
            bytes: 125_000,
            isKeyframe: false,
            targetKbps: 2_500,
            targetFps: 30,
            resolutionScale: 1.0,
            nowNs: 500_000_000
        ) == nil)

        let summary = tracker.noteSent(
            bytes: 125_000,
            isKeyframe: false,
            targetKbps: 2_500,
            targetFps: 30,
            resolutionScale: 1.0,
            nowNs: 1_000_000_000
        )

        #expect(summary == MediaProductionSummary(
            actualFps: 3,
            targetFps: 30,
            fpsDeficit: 27,
            frames: 3,
            keyframes: 1,
            sentKbps: 3_000,
            targetKbps: 2_500,
            maxGapMs: 500,
            resolutionScale: 1.0,
            windowMs: 1_000
        ))
    }

    @Test func inputCloseFrameRoundTripsThroughCodable() throws {
        let close = InputChannelClose(reason: "revoked")
        let data = try JSONEncoder().encode(close)
        let decoded = try JSONDecoder().decode(InputChannelClose.self, from: data)

        #expect(decoded == close)
        #expect(decoded.type == "input-close")
        #expect(decoded.reason == "revoked")
    }

    @Test func mediaTimingMathReportsMillisecondsPerAdvancedUnit() {
        let value = MediaTimingMath.millisecondsPerUnit(
            currentCount: 130,
            previousCount: 100,
            currentTotalSeconds: 2.2,
            previousTotalSeconds: 2.0
        )
        #expect(abs((value ?? 0) - 6.666) < 0.01)
    }

    @Test func mediaTimingMathReturnsNilWithoutUnitProgress() {
        let value = MediaTimingMath.millisecondsPerUnit(
            currentCount: 100,
            previousCount: 100,
            currentTotalSeconds: 2.2,
            previousTotalSeconds: 2.0
        )
        #expect(value == nil)
    }

    @Test func mediaTimingMathFormatsMillisecondsForLogs() {
        #expect(MediaTimingMath.millisecondsBetween(currentNs: 1_250_000, previousNs: 1_000_000) == 0.25)
        #expect(MediaTimingMath.formatMilliseconds(1.234) == "1.23")
        #expect(MediaTimingMath.formatMilliseconds(nil) == "?")
    }
}

struct QuicSessionHostMediaStateTests {
    private func controllerConfig() -> MediaQualityControllerConfig {
        MediaQualityControllerConfig(
            ceilingKbps: 2500,
            floorKbps: 800,
            survivalFloorKbps: 300,
            downStep: 0.7,
            upStep: 1.15,
            lossDownPermille: 50,
            raiseCleanWindows: 4,
            cadenceDownWindows: 2,
            fpsCeiling: 30,
            fpsFloor: 10,
            ackHoldP95Ms: 180,
            ackDownP95Ms: 350,
            cadenceGapMs: 500,
            freezeGapMs: 1_000,
            freezeFpsCeiling: 3,
            recoveryMaxGapMs: 300,
            recoveryMinFpsPermille: 800,
            transitionWarmupWindows: 1,
            capacity1Kbps: 650,
            capacity1Fps: 24,
            capacity1Scale: 0.75,
            capacity2Kbps: 400,
            capacity2Fps: 15,
            capacity2Scale: 0.5,
            emergencyKbps: 180, emergencyFps: 6, emergencyScale: 0.33,
            survivalScale: 0.5
        )
    }

    private func makeState(
        maxInflightFrames: Int = 2,
        maxInflightBytes: Int = 300_000
    ) -> QuicSessionHostMediaState {
        QuicSessionHostMediaState(
            maxInflightFrames: maxInflightFrames,
            maxInflightBytes: maxInflightBytes,
            expectedFrameRate: 30,
            qualityController: MediaQualityController(config: controllerConfig()),
            resendRingFrames: 4
        )
    }

    private func requireReady(
        _ admission: QuicSessionHostMediaState.Admission,
        _ message: @autoclosure () -> String
    ) throws -> OwnedSurfaceUpdateId {
        switch admission {
        case .ready(let updateId, _):
            return updateId
        case .retry(let afterNs, let reason):
            Issue.record("\(message()) (retry after \(afterNs)ns reason=\(reason.rawValue))")
            throw NSError(domain: "QuicSessionStreamFrameTests.AdmissionExpectationFailed", code: 1)
        }
    }

    @Test func mediaUpdateIdsStartAboveZeroAndIncrease() throws {
        var state = makeState()

        let first = try requireReady(state.reserveUpdateId(nowNs: 0), "expected first update id")
        let second = try requireReady(state.reserveUpdateId(nowNs: 1), "expected second update id")

        #expect(first.surfaceGeneration == 1)
        #expect(first.frameId == 1)
        #expect(second.frameId == 2)
    }

    @Test func inFlightAdmissionAbandonsOldestWithoutWaitingForAck() throws {
        var state = makeState(maxInflightFrames: 2)
        let first = try requireReady(state.reserveUpdateId(nowNs: 0), "expected first update id")
        state.noteSent(frameId: first.frameId, encodedBytes: 10, packets: [Data([1])])
        let second = try requireReady(state.reserveUpdateId(nowNs: 1), "expected second update id")
        state.noteSent(frameId: second.frameId, encodedBytes: 10, packets: [Data([2])])

        let thirdAdmission = state.reserveUpdateId(nowNs: 2)
        guard case .ready(let third, let abandoned) = thirdAdmission else {
            Issue.record("expected latest frame admission while max inflight frames are unacked")
            throw NSError(domain: "QuicSessionStreamFrameTests.AdmissionExpectationFailed", code: 2)
        }
        #expect(third.frameId == 3)
        #expect(abandoned.map(\.id) == [first.frameId])
        #expect(state.inFlightFrames == 1)

        state.noteSent(frameId: third.frameId, encodedBytes: 20, packets: [Data([3])])
        _ = state.noteAck(frameId: first.frameId)
        #expect(state.inFlightFrames == 2)
        #expect(state.inFlightBytes == 30)
    }

    @Test func resendRingServesRememberedPackets() throws {
        var state = makeState()
        let update = try requireReady(state.reserveUpdateId(nowNs: 0), "expected resend test update id")
        state.noteSent(
            frameId: update.frameId,
            encodedBytes: 2,
            packets: [Data([0]), Data([1])]
        )

        let served = state.packetsForResend(
            frameId: update.frameId,
            indexes: [0, 1, 9],
            maxCount: 8
        )

        #expect(served.packets.map { $0.0 } == [0, 1])
        #expect(served.packets.map { $0.1 } == [Data([0]), Data([1])])
        #expect(served.misses == [9])

        let decision = state.observeLinkHealth(
            completedFrames: 1,
            expiredFrames: 0,
            productionSummary: nil
        )
        #expect(decision.observation.freshness.resendPacketsServed == 2)
        #expect(decision.observation.freshness.resendPacketsMissed == 1)
        let reset = state.observeLinkHealth(
            completedFrames: 1,
            expiredFrames: 0,
            productionSummary: nil
        )
        #expect(reset.observation.freshness.resendPacketsServed == 0)
        #expect(reset.observation.freshness.resendPacketsMissed == 0)
    }

    @Test func linkHealthMovesAdaptiveTargets() {
        var state = makeState()

        let decision = state.observeLinkHealth(
            completedFrames: 80,
            expiredFrames: 20,
            productionSummary: nil,
            nowNs: 0
        )
        let outcome = decision.outcome

        #expect(outcome.changed)
        #expect(outcome.reason == "loss-down")
        #expect(decision.observation.windowId == 1)
        #expect(decision.observation.sample.completedFrames == 80)
        #expect(decision.observation.sample.expiredFrames == 20)
        #expect(decision.observation.signals.lossPressure)
        #expect(decision.changedAxes == "bitrate,rung")
        #expect(state.targetKbps < 2500)
        #expect(state.targetFps == 30)
    }

    @Test func qualityObservationIncludesAckAndBackpressureDiagnostics() throws {
        var state = makeState(maxInflightFrames: 1)
        let update = try requireReady(
            state.reserveUpdateId(nowNs: 1_000_000_000),
            "expected diagnostics update id"
        )
        state.noteSent(
            frameId: update.frameId,
            encodedBytes: 42,
            packets: [Data([1])],
            sentAtUptimeNs: 1_000_000_000
        )
        _ = state.reserveUpdateId(nowNs: 2_600_000_000)
        let decision = state.observeLinkHealth(
            completedFrames: 1,
            expiredFrames: 0,
            productionSummary: MediaProductionSummary(
                actualFps: 1,
                targetFps: 30,
                fpsDeficit: 29,
                frames: 1,
                keyframes: 1,
                sentKbps: 500,
                targetKbps: 2_500,
                maxGapMs: 1_600,
                resolutionScale: 1.0,
                windowMs: 1_000
            ),
            nowNs: 2_700_000_000
        )

        #expect(decision.observation.inFlightFrames == 0)
        #expect(decision.observation.inFlightBytes == 0)
        #expect(decision.observation.staleRecoveryCount == 1)
        #expect(decision.observation.freshness.abandonedFrames == 1)
        #expect(decision.observation.freshness.abandonedBytes == 42)
        #expect(decision.observation.signals.stalePressure)
        #expect(decision.observation.signals.cadencePressure)
        // R231b: one window of stale pressure holds rather than downshifting -- 47 of 51
        // measured bursts lasted exactly one window, and acting on each is what made the ladder
        // oscillate. R231: when it does downshift, resolution still is not in the list, because
        // it costs a keyframe and the other two axes are free.
        #expect(decision.outcome.target.rung == .native)
        #expect(decision.changedAxes == "none")
        #expect(decision.observation.ackCount == 0)
    }

    @Test func qualityObservationBoundsReplacedCaptureCountToItsWindow() {
        var state = makeState()
        state.noteCaptureReplaced()
        state.noteCaptureReplaced()

        let first = state.observeLinkHealth(
            completedFrames: 1,
            expiredFrames: 0,
            productionSummary: nil
        )
        let second = state.observeLinkHealth(
            completedFrames: 1,
            expiredFrames: 0,
            productionSummary: nil
        )

        #expect(first.observation.freshness.replacedCaptures == 2)
        #expect(second.observation.freshness.replacedCaptures == 0)
    }

    @Test func smoothnessCapacityDecisionReportsResolutionAxisAndReason() throws {
        var state = makeState()

        // Cadence pressure now requires the link to be genuinely stressed: a clean
        // link with sparse production reads as a calm screen, not a capacity
        // problem. Lag the ack past the hold threshold (180ms) so the poor cadence
        // is attributed to the link, not to a settled screen.
        func injectSlowAck(sentNs: UInt64, ackNs: UInt64) throws {
            let sent = try requireReady(
                state.reserveUpdateId(nowNs: sentNs),
                "expected update id for slow ack"
            )
            state.noteSent(frameId: sent.frameId, encodedBytes: 1_000, packets: [], sentAtUptimeNs: sentNs)
            _ = state.noteAck(frameId: sent.frameId, nowNs: ackNs)
        }

        try injectSlowAck(sentNs: 0, ackNs: 250_000_000)
        let hold = state.observeLinkHealth(
            completedFrames: 100,
            expiredFrames: 0,
            productionSummary: MediaProductionSummary(
                actualFps: 10,
                targetFps: 30,
                fpsDeficit: 20,
                frames: 10,
                keyframes: 0,
                sentKbps: 900,
                targetKbps: 2_500,
                maxGapMs: 650,
                resolutionScale: 1.0,
                windowMs: 1_000
            ),
            nowNs: 1_000_000_000
        )
        #expect(!hold.outcome.changed)
        #expect(hold.outcome.reason == "cadence-hold")

        try injectSlowAck(sentNs: 1_000_000_000, ackNs: 1_250_000_000)
        let down = state.observeLinkHealth(
            completedFrames: 100,
            expiredFrames: 0,
            productionSummary: MediaProductionSummary(
                actualFps: 10,
                targetFps: 30,
                fpsDeficit: 20,
                frames: 10,
                keyframes: 0,
                sentKbps: 900,
                targetKbps: 2_500,
                maxGapMs: 650,
                resolutionScale: 1.0,
                windowMs: 1_000
            ),
            nowNs: 2_000_000_000
        )

        #expect(down.outcome.reason == "cadence-capacity-down")
        // R231: same split. The decision is real and reaches the encoder as bitrate and fps;
        // the resolution component of the rung waits for the pressure to persist.
        #expect(down.changedAxes == "bitrate,fps,rung")
        #expect(down.outcome.target.resolutionScale == 1.0)
    }

    @Test func ackAgeIsComputedFromSentFrameTime() throws {
        var state = makeState()
        let update = try requireReady(state.reserveUpdateId(nowNs: 1_000_000_000), "expected ack-age update id")
        state.noteSent(
            frameId: update.frameId,
            encodedBytes: 10,
            packets: [Data([1])],
            sentAtUptimeNs: 1_000_000_000
        )

        let ageMs = state.noteAck(frameId: update.frameId, nowNs: 1_120_000_000)

        #expect(ageMs == 120)
        let decision = state.observeLinkHealth(
            completedFrames: 1,
            expiredFrames: 0,
            productionSummary: nil,
            nowNs: 1_120_000_000
        )
        #expect(decision.observation.ackCount == 1)
        #expect(decision.observation.sample.ackAgeP50Ms == 120)
        #expect(decision.observation.sample.ackAgeP95Ms == 120)
        #expect(decision.observation.ackAgeMaxMs == 120)
    }

    @Test func survivalFpsAddsCapacityAdmissionInterval() throws {
        var state = makeState()
        while state.targetFps == 30 {
            _ = state.observeLinkHealth(completedFrames: 80, expiredFrames: 20, productionSummary: nil)
        }
        #expect(state.targetFps < 30)

        let first = try requireReady(state.reserveUpdateId(nowNs: 0), "expected first survival update id")
        #expect(first.frameId == 1)
        let blocked = state.reserveUpdateId(nowNs: 1)
        if case .retry(_, let reason) = blocked {
            #expect(reason == .capacity)
        } else {
            Issue.record("expected cadence retry while survival fps gate is active")
            throw NSError(domain: "QuicSessionStreamFrameTests.AdmissionExpectationFailed", code: 3)
        }

        let afterCapacityInterval = try requireReady(
            state.reserveUpdateId(nowNs: 70_000_000),
            "expected update id after survival capacity interval"
        )
        #expect(afterCapacityInterval.frameId == 2)
    }

    @Test func qualityChangeResetReopensAdmissionWithoutClientKeyframeRequest() throws {
        var state = makeState(maxInflightFrames: 1)
        let first = try requireReady(state.reserveUpdateId(nowNs: 0), "expected first update id")
        state.noteSent(frameId: first.frameId, encodedBytes: 10, packets: [Data([1])])

        state.resetForQualityChange()

        let second = try requireReady(state.reserveUpdateId(nowNs: 1), "expected quality-reset update id")
        #expect(second.frameId == 2)
        let forcedKeyframe = state.takeClientKeyframeRequest()
        #expect(!forcedKeyframe)
    }

    @Test func immediateInflightAbandonmentDoesNotForceKeyframe() throws {
        var state = QuicSessionHostMediaState(
            maxInflightFrames: 1,
            maxInflightBytes: 300_000,
            expectedFrameRate: 30,
            qualityController: MediaQualityController(config: controllerConfig())
        )
        let first = try requireReady(state.reserveUpdateId(nowNs: 1_000_000_000), "expected first update id")
        state.noteSent(
            frameId: first.frameId,
            encodedBytes: 40_000,
            packets: [Data([1])],
            sentAtUptimeNs: 1_000_000_000
        )

        let second = try requireReady(
            state.reserveUpdateId(nowNs: 1_000_000_001),
            "expected immediate latest-frame admission"
        )

        #expect(second.frameId == 2)
        let forcedKeyframe = state.takeClientKeyframeRequest()
        #expect(!forcedKeyframe)
        let decision = state.observeLinkHealth(
            completedFrames: 1,
            expiredFrames: 0,
            productionSummary: nil,
            nowNs: 1_000_000_001
        )
        #expect(decision.observation.staleRecoveryCount == 1)
        #expect(decision.observation.signals.stalePressure)
    }
}
