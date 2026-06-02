import Foundation
import Testing

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

        try await Task.sleep(nanoseconds: 10_000_000)
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
