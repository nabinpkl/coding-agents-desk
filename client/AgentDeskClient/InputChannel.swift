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

    // R11: host -> client DesktopStatePush frames are surfaced here.
    // Stream completes when the channel closes. PairingViewController
    // observes this to drive the SpacesDotsView render.
    var desktopStateUpdates: AsyncStream<DesktopState> { get }

    // ADR-0006: host -> client thumbnails-push frames. Keys are
    // stringified UInt64 Space IDs per the wire shape; values are
    // base64-encoded JPEGs. PairingViewController decodes the JPEGs
    // into UIImage on the main thread and applies to ThumbnailStripView.
    var thumbnailsUpdates: AsyncStream<[String: String]> { get }

    // ADR-0006 (extended): dominant-window metadata per Space. Sent on
    // the same thumbnails-push frame, surfaced as a separate stream so
    // existing thumbnail subscribers don't need to change.
    var topWindowsUpdates: AsyncStream<[String: SpaceTopWindow]> { get }

    // ADR-0006: client -> host opt-in / force-refresh. Sent on channel
    // open and on settings change.
    func sendConfig(_ config: ClientConfig) async throws
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
    // R11: AsyncStream surfaces host-pushed DesktopState frames. The
    // receive loop spawned in init() decodes inbound text and yields
    // into this continuation. Stream finishes when the WS closes.
    private let desktopStateContinuation: AsyncStream<DesktopState>.Continuation
    let desktopStateUpdates: AsyncStream<DesktopState>
    // ADR-0006: thumbnails ride their own frame so the periodic
    // refresh cadence does not contaminate the event-driven
    // DesktopState push path.
    private let thumbnailsContinuation: AsyncStream<[String: String]>.Continuation
    let thumbnailsUpdates: AsyncStream<[String: String]>
    private let topWindowsContinuation: AsyncStream<[String: SpaceTopWindow]>.Continuation
    let topWindowsUpdates: AsyncStream<[String: SpaceTopWindow]>

    init(task: URLSessionWebSocketTask) {
        self.task = task
        var dsCont: AsyncStream<DesktopState>.Continuation!
        self.desktopStateUpdates = AsyncStream { dsCont = $0 }
        self.desktopStateContinuation = dsCont
        var thCont: AsyncStream<[String: String]>.Continuation!
        self.thumbnailsUpdates = AsyncStream { thCont = $0 }
        self.thumbnailsContinuation = thCont
        var twCont: AsyncStream<[String: SpaceTopWindow]>.Continuation!
        self.topWindowsUpdates = AsyncStream { twCont = $0 }
        self.topWindowsContinuation = twCont
        startReceiveLoop()
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

    // ADR-0006: opt-in toggle and force-refresh request.
    func sendConfig(_ config: ClientConfig) async throws {
        guard !closedFlag.isClosed else { throw InputChannelError.notOpen }
        let data: Data
        do {
            data = try encoder.encode(config)
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
        desktopStateContinuation.finish()
        thumbnailsContinuation.finish()
        topWindowsContinuation.finish()
        task.cancel(with: .normalClosure, reason: nil)
    }

    // Inbound frames classified by the `t` discriminator. Currently
    // only DesktopStatePush ("desktop-state") is server-initiated;
    // InputChannelClose ("input-close") would arrive here too if the
    // host ever emits one. Unknown discriminators are logged and
    // dropped rather than tearing down the channel.
    private func startReceiveLoop() {
        Task { [task, weak self] in
            while !(self?.closedFlag.isClosed ?? true) {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await task.receive()
                } catch {
                    inputLogger.notice("input channel receive ended: \(String(describing: error), privacy: .public)")
                    self?.desktopStateContinuation.finish()
                    self?.thumbnailsContinuation.finish()
                    return
                }
                self?.handleIncoming(message)
            }
        }
    }

    private func handleIncoming(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text):
            guard let d = text.data(using: .utf8) else { return }
            data = d
        case .data(let d):
            data = d
        @unknown default:
            return
        }
        // Peek at the discriminator before committing to a struct.
        // Unknown frames must not crash; the host may extend the wire
        // shape and the client should ignore frames it does not handle.
        guard let header = try? JSONDecoder().decode(InputFrameHeader.self, from: data) else {
            return
        }
        switch header.type {
        case "desktop-state":
            if let push = try? JSONDecoder().decode(DesktopStatePush.self, from: data) {
                desktopStateContinuation.yield(push.state)
            }
        case "thumbnails-push":
            if let push = try? JSONDecoder().decode(ThumbnailsPush.self, from: data) {
                thumbnailsContinuation.yield(push.thumbnails)
                topWindowsContinuation.yield(push.topWindows ?? [:])
            }
        default:
            inputLogger.debug("input channel ignored frame type=\(header.type, privacy: .public)")
        }
    }
}

// Minimal envelope used for inbound discriminator inspection. Mirrors
// the `t` key the host's compact-keyed frame structs use.
private struct InputFrameHeader: Decodable {
    let type: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
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
