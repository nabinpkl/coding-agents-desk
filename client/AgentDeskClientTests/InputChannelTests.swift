import Foundation
import Testing
import UIKit

// ADR-0005 input channel: schema and close-gating tests. The
// WebSocket-transport happy path is exercised by the Maestro flow
// (just ui-flow type-tap-keys) since URLSessionWebSocketTask isn't
// cleanly mockable without a live socket.

struct InputChannelTests {
    @Test func helloFrameSerializesWithCompactKeysAndCorrectType() throws {
        let hello = InputChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp-xyz"),
            sessionId: "session-123",
            inputCapability: "capability-abc"
        )
        let data = try JSONEncoder().encode(hello)
        let json = String(data: data, encoding: .utf8) ?? ""
        // Compact keys for type, device fingerprint, session id, and capability.
        #expect(json.contains("\"t\":\"input-hello\""))
        #expect(json.contains("\"d\""))
        #expect(json.contains("device-fp-xyz"))
        #expect(json.contains("\"sid\":\"session-123\""))
        #expect(json.contains("\"ic\":\"capability-abc\""))
    }

    @Test func readyFrameSerializesWithCompactKeysAndCorrectType() throws {
        let ready = InputChannelReady(sessionId: "session-123")
        let data = try JSONEncoder().encode(ready)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"input-ready\""))
        #expect(json.contains("\"sid\":\"session-123\""))

        let decoded = try JSONDecoder().decode(InputChannelReady.self, from: data)
        #expect(decoded == ready)
    }

    @Test func sessionReadyCarriesOwnedMediaCapability() throws {
        let ready = SessionReady(
            sessionId: "session-123",
            inputCapability: "input-capability",
            inputCapabilityExpiresAt: 1_800_000_060,
            mediaCapability: "media-capability",
            mediaCapabilityExpiresAt: 1_800_000_060
        )
        let data = try JSONEncoder().encode(ready)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"mc\":\"media-capability\""))
        #expect(json.contains("\"me\":1800000060"))
        #expect(!json.contains("\"mm\""))
        #expect(!json.contains("\"mp\""))

        let decoded = try JSONDecoder().decode(SessionReady.self, from: data)
        #expect(decoded == ready)
    }

    @Test func oldSessionReadyFixturesDefaultToNoMediaCapability() throws {
        let data = Data(#"{"t":"session-ready","sid":"session-123","ic":"capability","ie":1800000060}"#.utf8)
        let decoded = try JSONDecoder().decode(SessionReady.self, from: data)

        #expect(decoded.mediaCapability == "")
        #expect(decoded.mediaCapabilityExpiresAt == 0)
    }

    @Test func mediaHelloFrameSerializesWithCompactKeys() throws {
        let hello = MediaChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp-xyz"),
            sessionId: "session-123",
            mediaCapability: "media-capability",
            clientNonce: Data([1, 2, 3])
        )
        let data = try JSONEncoder().encode(hello)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"media-hello\""))
        #expect(json.contains("\"d\""))
        #expect(json.contains("device-fp-xyz"))
        #expect(json.contains("\"sid\":\"session-123\""))
        #expect(json.contains("\"mc\":\"media-capability\""))
        #expect(json.contains("\"cn\""))
    }

    @Test func ownedMediaControlFrameSerializesWithCompactKeys() throws {
        let message = OwnedMediaControlMessage(kind: .keyframeRequest, frameId: 42)
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(json.contains("\"t\":\"owned-media-control\""))
        #expect(json.contains("\"k\":\"keyframe-request\""))
        #expect(json.contains("\"id\":42"))
        #expect(!json.contains("\"px\""))
        #expect(!json.contains("\"td\""))
        #expect(!json.contains("\"rg\""))
        #expect(!json.contains("\"fa\""))
        #expect(!json.contains("\"qf\""))
        #expect(!json.contains("\"qb\""))
    }

    @Test func ownedMediaPacketResendControlSerializesWithCompactIndexes() throws {
        let message = OwnedMediaControlMessage(
            kind: .packetResendRequest,
            frameId: 42,
            packetIndexes: [1, 3]
        )
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(json.contains("\"k\":\"packet-resend-request\""))
        #expect(json.contains("\"px\":[1,3]"))
        #expect(!json.contains("\"td\""))
        #expect(!json.contains("\"rg\""))
        #expect(!json.contains("\"fa\""))
        #expect(!json.contains("\"qf\""))
        #expect(!json.contains("\"qb\""))
    }

    @Test func ownedMediaFrameAckControlSerializesWithCompactRenderStats() throws {
        let message = OwnedMediaControlMessage(
            kind: .frameAck,
            frameId: 42,
            totalFramesDecoded: 9,
            renderGapMs: 83.5,
            clientBacklogFrames: 1,
            clientBacklogBytes: 180_000
        )
        let data = try JSONEncoder().encode(message)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded == message)
        #expect(json.contains("\"k\":\"frame-ack\""))
        #expect(json.contains("\"id\":42"))
        #expect(json.contains("\"td\":9"))
        #expect(json.contains("\"rg\":83.5"))
        #expect(!json.contains("\"fa\""))
        #expect(json.contains("\"qf\":1"))
        #expect(json.contains("\"qb\":180000"))
        #expect(!json.contains("\"px\""))
    }

    @Test func ownedMediaFlushPolicyDoesNotFlushOrdinaryKeyframes() {
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "rendering",
            requiresFlushToResumeDecoding: false,
            isKeyframe: true,
            renderGapMs: 40,
            staleKeyframeFlushMs: 150
        ) == .none)
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "unknown",
            requiresFlushToResumeDecoding: false,
            isKeyframe: false,
            renderGapMs: 300,
            staleKeyframeFlushMs: 150
        ) == .none)
    }

    @Test func ownedMediaFlushPolicyFlushesOnlyFailedDisplayLayer() {
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "failed",
            requiresFlushToResumeDecoding: false,
            isKeyframe: false,
            renderGapMs: 40,
            staleKeyframeFlushMs: 150
        ) == .flushAndRemoveImage)
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "rendering",
            requiresFlushToResumeDecoding: true,
            isKeyframe: false,
            renderGapMs: 40,
            staleKeyframeFlushMs: 150
        ) == .flushAndRemoveImage)
    }

    @Test func ownedMediaFlushPolicyFlushesOnlyStaleKeyframeForQueueDiscipline() {
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "rendering",
            requiresFlushToResumeDecoding: false,
            isKeyframe: false,
            renderGapMs: 250,
            staleKeyframeFlushMs: 150
        ) == .none)
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "rendering",
            requiresFlushToResumeDecoding: false,
            isKeyframe: true,
            renderGapMs: 149,
            staleKeyframeFlushMs: 150
        ) == .none)
        #expect(OwnedMediaDisplayQueuePolicy.action(
            displayStatus: "rendering",
            requiresFlushToResumeDecoding: false,
            isKeyframe: true,
            renderGapMs: 150,
            staleKeyframeFlushMs: 150
        ) == .flushAndRemoveImage)
    }

    @Test func ownedMediaRenderTimingReportsMilliseconds() {
        #expect(OwnedMediaRenderTiming.elapsedMs(from: 1_000_000, to: 3_500_000) == 2.5)
    }

    @Test func ownedMediaBacklogEstimateReportsBacklogAfterLargeRenderGap() {
        let underOneFrame = OwnedMediaRenderBacklog.estimate(renderGapMs: 32.0, payloadBytes: 200_000)
        let overBudget = OwnedMediaRenderBacklog.estimate(renderGapMs: 83.5, payloadBytes: 200_000)

        #expect(underOneFrame.frames == 0)
        #expect(underOneFrame.bytes == 0)
        #expect(overBudget.frames == 1)
        #expect(overBudget.bytes == 200_000)
    }

    @Test func ownedMediaRenderStatsMapsToFrameAckPayload() throws {
        let stats = OwnedMediaRenderStats(
            frameId: 55,
            totalFramesDecoded: 13,
            renderGapMs: 120.0,
            renderStartUptimeNs: 2_000_000,
            renderEndUptimeNs: 4_000_000,
            payloadBytes: 210_000,
            flushCount: 0,
            displayStatus: "rendering",
            displayReadyBeforeEnqueue: true,
            requiresFlushToResumeDecoding: false,
            sampleBuildMs: 1.5,
            enqueueMs: 0.25,
            renderWorkMs: 2.0,
            displayQueueAction: .none,
            clientBacklogFrames: 2,
            clientBacklogBytes: 210_000
        )
        let message = OwnedMediaControlMessage(
            kind: .frameAck,
            frameId: stats.frameId,
            totalFramesDecoded: stats.totalFramesDecoded,
            renderGapMs: stats.renderGapMs,
            clientBacklogFrames: stats.clientBacklogFrames,
            clientBacklogBytes: stats.clientBacklogBytes
        )
        let data = try JSONEncoder().encode(message)
        let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

        #expect(decoded.kind == .frameAck)
        #expect(decoded.frameId == stats.frameId)
        #expect(decoded.totalFramesDecoded == stats.totalFramesDecoded)
        #expect(decoded.renderGapMs == stats.renderGapMs)
        #expect(decoded.clientBacklogFrames == stats.clientBacklogFrames)
        #expect(decoded.clientBacklogBytes == stats.clientBacklogBytes)
    }

    @Test func ownedMediaFrameTimelineFormatsCompleteToAckPath() {
        let timeline = OwnedMediaFrameTimeline(
            frameId: 55,
            isKeyframe: false,
            wasRepaired: true,
            packetCount: 42,
            payloadBytes: 210_000,
            firstPacketToCompleteMs: 18.24,
            completeToRenderStartMs: 2.0,
            mainActorWaitMs: 1.5,
            sampleBuildMs: 0.76,
            enqueueMs: 0.24,
            renderWorkMs: 1.25,
            ackSendMs: 0.5,
            completeToAckSentMs: 4.0,
            displayReadyBeforeEnqueue: true,
            requiresFlushToResumeDecoding: false,
            displayQueueAction: .none,
            displayStatus: "rendering"
        )

        #expect(timeline.traceLine.contains("timeline frame=55 key=false repaired=true"))
        #expect(timeline.traceLine.contains("firstToCompleteMs=18.2"))
        #expect(timeline.traceLine.contains("completeToRenderStartMs=2.0"))
        #expect(timeline.traceLine.contains("mainActorWaitMs=1.5"))
        #expect(timeline.traceLine.contains("sampleMs=0.8"))
        #expect(timeline.traceLine.contains("enqueueMs=0.2"))
        #expect(timeline.traceLine.contains("ackSendMs=0.5"))
        #expect(timeline.traceLine.contains("completeToAckMs=4.0"))
        #expect(timeline.traceLine.contains("ready=true requiresFlush=false action=none display=rendering"))
    }

    @Test func ownedMediaEnvelopeRoundTripsHeaderAndPayload() throws {
        let header = OwnedMediaFrameHeader(
            frameId: 1,
            codec: .h264,
            width: 1280,
            height: 720,
            capturedAtUptimeNs: 10,
            presentationTimeNs: 20,
            isKeyframe: false,
            parameterSets: nil
        )
        let envelope = OwnedMediaFrameEnvelope(header: header, payload: Data([0x10, 0x20]))
        let decoded = try OwnedMediaFrameEnvelope.decode(envelope.encode())

        #expect(decoded == envelope)
    }

    @Test func ownedMediaKeyframeRequestsAreDebouncedDuringRecovery() {
        var throttle = OwnedMediaKeyframeRequestThrottle()

        let firstRequest = throttle.noteIncompleteFrame(now: 1_000)
        #expect(firstRequest)
        #expect(throttle.isAwaitingKeyframe)
        let immediateRetry = throttle.noteIncompleteFrame(now: 1_000 + 100_000_000)
        let earlyDeltaRetry = throttle.noteSkippedDelta(now: 1_000 + 499_000_000)
        let dueDeltaRetry = throttle.noteSkippedDelta(now: 1_000 + 500_000_000)
        #expect(!immediateRetry)
        #expect(!earlyDeltaRetry)
        #expect(dueDeltaRetry)

        throttle.noteKeyframe()

        #expect(!throttle.isAwaitingKeyframe)
        let postKeyframeRequest = throttle.noteIncompleteFrame(now: 2_000_000_000)
        #expect(postKeyframeRequest)
    }

    @Test func repairBufferRequestsMissingIndexesWhenNewerFrameExposesGap() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3), now: 1)
        let result = buffer.accept(packet(frameId: 2, index: 0, count: 1), now: 2)

        #expect(result.resendRequests == [
            MediaDatagramRepairRequest(
                frameId: 1,
                packetIndexes: [1, 2],
                requestedAtNs: 2,
                firstSeenAgeNs: 1
            )
        ])
        #expect(result.completedFrames.isEmpty)
        #expect(result.expiredFrames.isEmpty)
    }

    @Test func repairBufferSuppressesDuplicateRequestsDuringRepairWindow() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 2), now: 2)
        let duplicate = buffer.accept(packet(frameId: 2, index: 1, count: 2), now: 3)

        #expect(duplicate.resendRequests.isEmpty)
    }

    @Test func repairBufferCompletesFrameAfterResendBeforeDeadline() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, payload: [0x10]), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1, payload: [0x20]), now: 2)
        _ = buffer.accept(packet(frameId: 1, index: 1, count: 3, payload: [0x11]), now: 10)
        let repaired = buffer.accept(packet(frameId: 1, index: 2, count: 3, payload: [0x12]), now: 20)

        #expect(repaired.expiredFrames.isEmpty)
        #expect(repaired.repairedFrameCount == 1)
        #expect(repaired.completedFrames.map(\.frameId) == [1, 2])
        #expect(repaired.completedFrames.first?.data == Data([0x10, 0x11, 0x12]))
        #expect(repaired.completedFrames.first?.wasRepaired == true)
        #expect(repaired.completedFrames.first?.firstSeenAgeNs == 19)
        #expect(repaired.completedFrames.first?.repairedAfterNs == 18)
    }

    @Test func repairBufferSkipsLateRepairedDeltaAfterDeadline() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, payload: [0x10]), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1, payload: [0x20]), now: 2)
        _ = buffer.accept(packet(frameId: 1, index: 1, count: 3, payload: [0x11]), now: 10)
        let late = buffer.accept(packet(frameId: 1, index: 2, count: 3, payload: [0x12]), now: 53)

        #expect(late.expiredFrames.isEmpty)
        #expect(late.repairedFrameCount == 0)
        #expect(late.completedFrames.map(\.frameId) == [2])
        #expect(late.skippedStaleFrames == [
            IncompleteFrame(
                frameId: 1,
                isKeyframe: false,
                received: 3,
                expected: 3,
                missingIndexes: [],
                firstSeenAgeNs: 52,
                repairAgeNs: 51
            )
        ])
    }

    @Test func repairBufferAllowsLateRepairedKeyframeToComplete() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, isKeyframe: true, payload: [0x10]), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1, payload: [0x20]), now: 2)
        _ = buffer.accept(packet(frameId: 1, index: 1, count: 3, isKeyframe: true, payload: [0x11]), now: 10)
        let late = buffer.accept(packet(frameId: 1, index: 2, count: 3, isKeyframe: true, payload: [0x12]), now: 53)

        #expect(late.expiredFrames.isEmpty)
        #expect(late.skippedStaleFrames.isEmpty)
        #expect(late.repairedFrameCount == 1)
        #expect(late.completedFrames.map(\.frameId) == [1, 2])
        #expect(late.completedFrames.first?.data == Data([0x10, 0x11, 0x12]))
        #expect(late.completedFrames.first?.wasRepaired == true)
    }

    @Test func repairBufferSkipsStaleDeltaAfterRepairDeadline() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1), now: 2)
        let skipped = buffer.accept(packet(frameId: 3, index: 0, count: 1), now: 52)

        #expect(skipped.expiredFrames.isEmpty)
        #expect(skipped.skippedStaleFrames == [
            IncompleteFrame(
                frameId: 1,
                isKeyframe: false,
                received: 1,
                expected: 3,
                missingIndexes: [1, 2],
                firstSeenAgeNs: 51,
                repairAgeNs: 50
            )
        ])
        #expect(skipped.completedFrames.map(\.frameId) == [2, 3])
    }

    @Test func repairBufferFallsBackWhenKeyframeExpires() {
        let buffer = MediaDatagramFrameRepairBuffer(
            repairDeadlineNs: 50,
            trackedFrameLimit: 8,
            maxResendPackets: 256
        )

        _ = buffer.accept(packet(frameId: 1, index: 0, count: 3, isKeyframe: true), now: 1)
        _ = buffer.accept(packet(frameId: 2, index: 0, count: 1, payload: [0x20]), now: 2)
        let expired = buffer.accept(packet(frameId: 3, index: 0, count: 1, payload: [0x30]), now: 52)

        #expect(expired.expiredFrames == [
            IncompleteFrame(
                frameId: 1,
                isKeyframe: true,
                received: 1,
                expected: 3,
                missingIndexes: [1, 2],
                firstSeenAgeNs: 51,
                repairAgeNs: 50
            )
        ])
        #expect(expired.skippedStaleFrames.isEmpty)
    }

    @Test func eventFramePreservesNormalizedInput() throws {
        let event = NormalizedInput.cursorMove(dx: 1.5, dy: -2.25)
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)
        #expect(decoded.event == event)
    }

    @Test func eventFrameRoundTripPreservesKeyWithModifiers() throws {
        let event = NormalizedInput.key(code: "ansi-K", modifiers: [.cmd, .ctrl, .option, .shift])
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)
        #expect(decoded.event == event)
    }

    @Test func agentSayFrameSerializesWithCompactKeysAndChannelYieldsIt() async throws {
        let push = AgentSayPush(id: "utterance-1", phase: "chunk", sequence: 0, text: "hello")
        let data = try JSONEncoder().encode(push)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"agent-say\""))
        #expect(json.contains("\"p\":\"chunk\""))
        #expect(json.contains("\"q\":0"))
        #expect(json.contains("\"x\":\"hello\""))

        let task = FakeInputWebSocketTask()
        let channel = WebSocketInputChannel(task: task)
        var iterator = channel.agentSayUpdates.makeAsyncIterator()
        try task.enqueueReceive(.string(json))
        let received = await iterator.next()
        #expect(received == push)
        channel.close()
    }

    @Test func cursorFrameDecodesAndChannelYieldsIt() async throws {
        let push = CursorImagePush(
            hash: "abc123",
            png: "Zm9v",
            hotspotXFrac: 0.5,
            hotspotYFrac: 0.25,
            widthPoints: 16,
            heightPoints: 24,
            hidden: false
        )
        let data = try JSONEncoder().encode(push)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"cursor\""))

        let task = FakeInputWebSocketTask()
        let channel = WebSocketInputChannel(task: task)
        var iterator = channel.cursorUpdates.makeAsyncIterator()
        try task.enqueueReceive(.string(json))
        let received = await iterator.next()
        #expect(received == push)
        channel.close()
    }

    @Test func cursorImageStoreCachesByHashAndServesNilPayloadFromCache() {
        // 1x1 PNG, enough for UIImage(data:) to succeed.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC"
        let store = CursorImageStore()
        let withBytes = CursorImagePush(
            hash: "h1", png: png,
            hotspotXFrac: 0, hotspotYFrac: 0,
            widthPoints: 1, heightPoints: 1, hidden: false
        )
        #expect(store.resolve(withBytes) != nil)

        // Same hash, no bytes: served from cache.
        let hashOnly = CursorImagePush(
            hash: "h1", png: nil,
            hotspotXFrac: 0, hotspotYFrac: 0,
            widthPoints: 1, heightPoints: 1, hidden: false
        )
        #expect(store.resolve(hashOnly) != nil)

        // Unknown hash, no bytes: nothing to render.
        let unknown = CursorImagePush(
            hash: "h2", png: nil,
            hotspotXFrac: 0, hotspotYFrac: 0,
            widthPoints: 1, heightPoints: 1, hidden: false
        )
        #expect(store.resolve(unknown) == nil)
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

    @Test func openerReturnsOnlyAfterInputReady() async throws {
        let task = FakeInputWebSocketTask()
        let completed = LockedBool(false)
        let openTask = Task {
            let channel = try await InputChannelOpener.open(
                host: "mac.tailnet.ts.net",
                port: 41888,
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123",
                inputCapability: "capability-abc",
                taskFactory: FakeInputWebSocketTaskFactory(task: task)
            )
            completed.set(true)
            return channel
        }

        try await waitUntil { task.sentTexts.count == 1 }
        #expect(task.didResume)
        #expect(task.sentTexts.count == 1)
        #expect(task.receiveWaiterCount == 1)
        #expect(completed.value == false)

        try task.enqueueReceive(.string(String(data: JSONEncoder().encode(InputChannelReady(sessionId: "session-123")), encoding: .utf8)!))
        let channel = try await openTask.value
        #expect(completed.value)
        channel.close()
    }

    @Test func openerThrowsDecodedSessionRejectedBeforeReady() async throws {
        let task = FakeInputWebSocketTask()
        try task.enqueueReceive(.string(String(data: JSONEncoder().encode(SessionRejected(reason: .revoked)), encoding: .utf8)!))

        do {
            _ = try await InputChannelOpener.open(
                host: "mac.tailnet.ts.net",
                port: 41888,
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123",
                inputCapability: "capability-abc",
                taskFactory: FakeInputWebSocketTaskFactory(task: task)
            )
            Issue.record("input opener unexpectedly returned a channel")
        } catch let rejection as SessionRejected {
            #expect(rejection.reason == .revoked)
        }
        #expect(task.cancelCode == .protocolError)
    }

    @Test func openerTreatsUnknownPreReadyFrameAsMalformedAndCloses() async throws {
        let task = FakeInputWebSocketTask()
        try task.enqueueReceive(.string(#"{"t":"desktop-state"}"#))

        do {
            _ = try await InputChannelOpener.open(
                host: "mac.tailnet.ts.net",
                port: 41888,
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123",
                inputCapability: "capability-abc",
                taskFactory: FakeInputWebSocketTaskFactory(task: task)
            )
            Issue.record("input opener unexpectedly returned a channel")
        } catch let rejection as SessionRejected {
            #expect(rejection.reason == .malformed)
        }
        #expect(task.cancelCode == .protocolError)
    }

    private func packet(
        frameId: UInt64,
        index: UInt16,
        count: UInt16,
        isKeyframe: Bool = false,
        payload: [UInt8] = [0xff]
    ) -> MediaDatagramFramePacket {
        MediaDatagramFramePacket(
            frameId: frameId,
            packetIndex: index,
            packetCount: count,
            isKeyframe: isKeyframe,
            sentAtUptimeNs: 0,
            payload: Data(payload)
        )
    }
}

private struct FakeInputWebSocketTaskFactory: InputWebSocketTaskFactory {
    let task: FakeInputWebSocketTask

    func makeTask(url: URL) -> InputWebSocketTask {
        task
    }
}

private final class FakeInputWebSocketTask: InputWebSocketTask, @unchecked Sendable {
    private let lock = NSLock()
    private var receiveResults: [Result<URLSessionWebSocketTask.Message, Error>] = []
    private var receiveContinuations: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = []
    private var cancelled = false
    private var _didResume = false
    private var _sentTexts: [String] = []
    private var _cancelCode: URLSessionWebSocketTask.CloseCode?

    var didResume: Bool { lock.withLock { _didResume } }
    var sentTexts: [String] { lock.withLock { _sentTexts } }
    var receiveWaiterCount: Int { lock.withLock { receiveContinuations.count } }
    var cancelCode: URLSessionWebSocketTask.CloseCode? { lock.withLock { _cancelCode } }

    func resume() {
        lock.withLock { _didResume = true }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        lock.withLock {
            switch message {
            case .string(let text):
                _sentTexts.append(text)
            case .data(let data):
                _sentTexts.append(String(data: data, encoding: .utf8) ?? "")
            @unknown default:
                break
            }
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            if let immediate = takeReceiveOrStore(continuation) {
                continuation.resume(with: immediate)
            }
        }
    }

    private func takeReceiveOrStore(
        _ continuation: CheckedContinuation<URLSessionWebSocketTask.Message, Error>
    ) -> Result<URLSessionWebSocketTask.Message, Error>? {
        lock.withLock {
            if cancelled {
                return .failure(CancellationError())
            }
            if !receiveResults.isEmpty {
                return receiveResults.removeFirst()
            }
            receiveContinuations.append(continuation)
            return nil
        }
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let continuations: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>]
        lock.lock()
        cancelled = true
        _cancelCode = closeCode
        continuations = receiveContinuations
        receiveContinuations.removeAll()
        lock.unlock()

        for continuation in continuations {
            continuation.resume(throwing: CancellationError())
        }
    }

    func enqueueReceive(_ message: URLSessionWebSocketTask.Message) throws {
        enqueueReceive(.success(message))
    }

    private func enqueueReceive(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        if let continuation = takeContinuationOrStore(result) {
            continuation.resume(with: result)
        }
    }

    private func takeContinuationOrStore(
        _ result: Result<URLSessionWebSocketTask.Message, Error>
    ) -> CheckedContinuation<URLSessionWebSocketTask.Message, Error>? {
        lock.withLock {
            if receiveContinuations.isEmpty {
                receiveResults.append(result)
                return nil
            }
            return receiveContinuations.removeFirst()
        }
    }
}

private final class LockedBool: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Bool

    init(_ value: Bool) {
        stored = value
    }

    var value: Bool {
        lock.withLock { stored }
    }

    func set(_ value: Bool) {
        lock.withLock { stored = value }
    }
}

private func waitUntil(
    timeoutNanoseconds: UInt64 = 1_000_000_000,
    _ predicate: @escaping @Sendable () -> Bool
) async throws {
    let deadline = ContinuousClock.now + .nanoseconds(Int(timeoutNanoseconds))
    while !predicate() {
        if ContinuousClock.now >= deadline { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
}
