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

    @Test func interactionHintSerializesWithCompactKeys() throws {
        let hint = InteractionHint(kind: "scroll", active: true)
        let data = try JSONEncoder().encode(hint)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"interaction-hint\""))
        #expect(json.contains("\"k\":\"scroll\""))
        #expect(json.contains("\"a\":true"))
        let decoded = try JSONDecoder().decode(InteractionHint.self, from: data)
        #expect(decoded == hint)
    }

    @Test func sdpCodecInspectorReportsFirstVideoCodecAndH264Profile() {
        let sdp = """
        v=0
        m=video 9 UDP/TLS/RTP/SAVPF 96 97 98
        a=rtpmap:96 H264/90000
        a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c34
        a=rtpmap:97 rtx/90000
        a=fmtp:97 apt=96
        a=rtpmap:98 VP9/90000
        """
        let codec = SdpVideoCodecInspector.firstNegotiatedVideoCodec(in: sdp)
        #expect(codec?.name == "H264")
        #expect(codec?.payloadType == "96")
        #expect(codec?.h264ProfileLevelId == "640c34")
        #expect(codec?.logSummary == "H264 pt=96 profile-level-id=640c34")
    }

    @Test func sdpCodecInspectorSkipsRepairPayloads() {
        let sdp = """
        v=0
        m=video 9 UDP/TLS/RTP/SAVPF 97 96
        a=rtpmap:97 rtx/90000
        a=fmtp:97 apt=96
        a=rtpmap:96 H264/90000
        a=fmtp:96 profile-level-id=42e034
        """
        let codec = SdpVideoCodecInspector.firstNegotiatedVideoCodec(in: sdp)
        #expect(codec?.name == "H264")
        #expect(codec?.payloadType == "96")
    }

    @Test func sdpCodecInspectorReturnsNilWithoutVideoMedia() {
        let sdp = """
        v=0
        m=audio 9 UDP/TLS/RTP/SAVPF 111
        a=rtpmap:111 opus/48000/2
        """
        #expect(SdpVideoCodecInspector.firstNegotiatedVideoCodec(in: sdp) == nil)
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

    @Test func h264OnlyCodecPolicyDropsSoftwareCodecFallbacks() {
        let allowed = CodecPreferencePolicy.orderedAllowedIndexes(
            capabilities: [
                CodecCapabilityDescriptor(index: 0, name: "H264", preferredPayloadType: "96", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 1, name: "rtx", preferredPayloadType: "97", aptPayloadType: "96"),
                CodecCapabilityDescriptor(index: 2, name: "VP9", preferredPayloadType: "98", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 3, name: "rtx", preferredPayloadType: "99", aptPayloadType: "98"),
                CodecCapabilityDescriptor(index: 4, name: "VP8", preferredPayloadType: "100", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 5, name: "red", preferredPayloadType: "101", aptPayloadType: nil)
            ],
            preferences: .h264Only
        )

        #expect(allowed == [0, 1, 5])
        #expect(MediaCodecPreferences.h264Only.allows(statsMimeType: "video/H264"))
        #expect(!MediaCodecPreferences.h264Only.allows(statsMimeType: "video/VP8"))
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
            var immediate: Result<URLSessionWebSocketTask.Message, Error>?
            lock.lock()
            if cancelled {
                immediate = .failure(CancellationError())
            } else if !receiveResults.isEmpty {
                immediate = receiveResults.removeFirst()
            } else {
                receiveContinuations.append(continuation)
            }
            lock.unlock()

            if let immediate {
                continuation.resume(with: immediate)
            }
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
        var continuation: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
        lock.lock()
        if receiveContinuations.isEmpty {
            receiveResults.append(result)
        } else {
            continuation = receiveContinuations.removeFirst()
        }
        lock.unlock()

        if let continuation {
            continuation.resume(with: result)
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
