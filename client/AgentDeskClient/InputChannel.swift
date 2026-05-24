import Foundation
import OSLog

// ADR-0005 input channel, client side. Opens a dedicated WebSocket
// Secure connection to the host's signaling port, sends an
// InputChannelHello first frame carrying the SessionToken, then ships
// one InputChannelEvent per NormalizedInput emitted by the trackpad,
// keyboard, or accessory row.
//
// Independent of the WebRTC PeerConnection that carries video: dropping
// the input WS does not tear down video, and vice versa. PairingClient
// owns one instance per active session and exposes it through
// ActiveSession.

protocol InputChannel: AnyObject, Sendable {
    func send(_ input: NormalizedInput) async throws
    func close()
}

enum InputChannelError: Error {
    case notOpen
    case encodeFailed
    case malformedURL
}

private let inputLogger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "input-channel")

// Closed-state holder. OSAllocatedUnfairLock is async-safe (no
// blocking semantics in async contexts that would warn under Swift 6).
private final class CloseFlag: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock<Bool>(initialState: false)
    var isClosed: Bool { lock.withLock { $0 } }
    func close() -> Bool {
        lock.withLock { wasClosed in
            defer { wasClosed = true }
            return wasClosed
        }
    }
}

final class WebSocketInputChannel: InputChannel, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let encoder = JSONEncoder()
    private let closedFlag = CloseFlag()

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func send(_ input: NormalizedInput) async throws {
        guard !closedFlag.isClosed else { throw InputChannelError.notOpen }
        let frame = InputChannelEvent(event: input)
        let data: Data
        do {
            data = try encoder.encode(frame)
        } catch {
            throw InputChannelError.encodeFailed
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw InputChannelError.encodeFailed
        }
        try await task.send(.string(text))
    }

    func close() {
        let wasClosed = closedFlag.close()
        guard !wasClosed else { return }
        task.cancel(with: .normalClosure, reason: nil)
    }
}

// Opens the WS, sends the hello, returns a ready-to-send channel.
// Factored out so PairingClient.attemptSession can construct one
// alongside the WebRTC PeerConnection without growing the dialer.
enum InputChannelOpener {
    static func open(
        host: String,
        port: UInt16,
        sessionToken: SessionToken,
        urlSession: URLSession
    ) async throws -> InputChannel {
        guard let url = URL(string: "wss://\(host):\(port)/input") else {
            throw InputChannelError.malformedURL
        }
        let task = urlSession.webSocketTask(with: url)
        task.resume()
        let hello = InputChannelHello(sessionToken: sessionToken)
        let helloData = try JSONEncoder().encode(hello)
        guard let helloText = String(data: helloData, encoding: .utf8) else {
            task.cancel(with: .protocolError, reason: nil)
            throw InputChannelError.encodeFailed
        }
        do {
            try await task.send(.string(helloText))
        } catch {
            task.cancel(with: .protocolError, reason: nil)
            throw error
        }
        inputLogger.notice("input channel opened host=\(host, privacy: .public)")
        return WebSocketInputChannel(task: task)
    }
}
