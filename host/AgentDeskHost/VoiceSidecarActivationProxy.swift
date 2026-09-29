import Foundation
import Network
import os

// VoiceSidecarActivationProxy owns the voice port so the Python server behind it
// can be absent until someone connects.
//
// Every voice consumer dials one loopback port: the phone's voice lane through
// VoiceLaneServer, and the Mac dictation and gesture webviews directly, from the
// ws URL the host injects. The webviews never ask the host first, so the host
// cannot start the server "when voice is needed" by any signal other than the
// connection itself. This listener is that signal: each accepted connection that
// sends a real request asks for a backend (which starts the server if none is
// running), is piped to it byte for byte, and reports when it closes, which is
// what lets the supervisor stop the server once nothing is connected. A
// connection that sends nothing, or only a port scanner's probe
// (VoiceProbeRequest), never asks.
//
// Loopback only, like the server it fronts: the listener binds 127.0.0.1 and
// nothing else.
final class VoiceSidecarActivationProxy: @unchecked Sendable {
    /// Counts a connection toward keeping the server up, starting it if needed.
    /// Synchronous so that it is always queued before the same connection's
    /// `release`, however soon the client hangs up. Balanced by exactly one `release`.
    typealias Acquire = @Sendable () -> Void
    /// The backend's base URL once it answers, or nil when it could not be started.
    typealias Backend = @Sendable () async -> URL?
    typealias Release = @Sendable () -> Void

    private let port: UInt16
    private let acquire: Acquire
    private let backend: Backend
    private let release: Release
    private let onReady: @Sendable (URL) -> Void
    private let logger = Logger(subsystem: Config.logSubsystem, category: "voice-activation-proxy")
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).voice-activation-proxy")

    private var listener: NWListener?
    private var connections: [ObjectIdentifier: ProxiedVoiceConnection] = [:]
    private var stopped = false
    private var retryDelaySeconds: TimeInterval = 1
    private static let maxRetryDelaySeconds: TimeInterval = 16

    init(
        port: UInt16,
        acquire: @escaping Acquire,
        backend: @escaping Backend,
        release: @escaping Release,
        onReady: @escaping @Sendable (URL) -> Void
    ) {
        self.port = port
        self.acquire = acquire
        self.backend = backend
        self.release = release
        self.onReady = onReady
    }

    func start() {
        queue.async { [weak self] in self?.listen() }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.listener?.cancel()
            self.listener = nil
            for connection in self.connections.values { connection.close() }
            self.connections.removeAll()
        }
    }

    private func listen() {
        guard !stopped, listener == nil else { return }
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            logger.error("voice activation proxy has no valid port \(self.port, privacy: .public)")
            return
        }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: nwPort)
        parameters.allowLocalEndpointReuse = true
        let listener: NWListener
        do {
            listener = try NWListener(using: parameters)
        } catch {
            logger.error("voice activation proxy could not listen port=\(self.port, privacy: .public): \(String(describing: error), privacy: .public)")
            scheduleRelisten()
            return
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self, let listener else { return }
            switch state {
            case .ready:
                self.retryDelaySeconds = 1
                self.logger.notice("voice activation proxy listening port=\(self.port, privacy: .public)")
                self.onReady(URL(string: "http://127.0.0.1:\(self.port)")!)
            case .failed(let error):
                // A port still held by an orphaned server from a killed host lands here.
                // Retry rather than give up: the orphan may be reclaimed or exit.
                self.logger.error("voice activation proxy failed port=\(self.port, privacy: .public): \(String(describing: error), privacy: .public)")
                listener.cancel()
                if self.listener === listener { self.listener = nil }
                self.scheduleRelisten()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] client in
            self?.accept(client)
        }
        self.listener = listener
        listener.start(queue: queue)
    }

    private func scheduleRelisten() {
        guard !stopped else { return }
        let delay = retryDelaySeconds
        retryDelaySeconds = min(retryDelaySeconds * 2, Self.maxRetryDelaySeconds)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in self?.listen() }
    }

    // Runs on `queue`.
    private func accept(_ client: NWConnection) {
        guard !stopped else {
            client.cancel()
            return
        }
        let release = self.release
        let connection = ProxiedVoiceConnection(client: client, queue: queue) { [weak self] id, acquired in
            // Runs on `queue`, exactly once per connection.
            self?.connections.removeValue(forKey: id)
            if acquired { release() }
        }
        connections[ObjectIdentifier(connection)] = connection
        client.start(queue: queue)
        let acquire = self.acquire
        let backendURL = self.backend
        let queue = self.queue
        let logger = self.logger
        // Nothing is asked of the backend until the client says what it wants. A
        // connection that never sends a byte does not start the server, and one
        // that only asks what a port scanner asks is answered here.
        connection.readRequestHead { head in
            if VoiceProbeRequest.isProbe(head) {
                connection.answerProbe()
                return
            }
            connection.markAcquired()
            acquire()
            Task {
                let backend = await backendURL()
                queue.async {
                    guard let backend,
                          let rawPort = backend.port,
                          let backendPort = NWEndpoint.Port(rawValue: UInt16(rawPort))
                    else {
                        logger.error("voice activation proxy has no backend; closing connection")
                        connection.close()
                        return
                    }
                    connection.attach(
                        upstream: NWConnection(host: .ipv4(.loopback), port: backendPort, using: .tcp),
                        sending: head
                    )
                }
            }
        }
    }
}

/// Requests that do not wake the voice server.
///
/// Anything that lists this Mac's listening ports and asks each one what it is
/// sends these. Measured 2026-09-28: a homepage that labels every local port
/// fetched `GET /` and `GET /favicon.ico` from the voice port every 30 to 70
/// seconds, so an idle stop never came and 2.4GB stayed resident. No voice client
/// asks for either path; they speak to `/ws/voice`, `/recordings`, `/health` and
/// the rest of the server's routes.
enum VoiceProbeRequest {
    static let probePaths: Set<String> = ["/", "/favicon.ico"]
    static let response = Data(
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8
    )

    /// Whether the bytes a connection opened with are a probe. Only the request line
    /// is read: `<METHOD> <path>[?query] HTTP/x`.
    static func isProbe(_ head: Data) -> Bool {
        guard let lineEnd = head.firstIndex(of: UInt8(ascii: "\n")) else { return false }
        let line = String(decoding: head[head.startIndex..<lineEnd], as: UTF8.self)
        let parts = line.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else { return false }
        let path = parts[1].split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
        return probePaths.contains(String(path))
    }
}

// One client connection piped to one backend connection. All state lives on the
// proxy's queue. Each direction half-closes on its own EOF, so an HTTP client
// that shuts down its write side still reads the reply; the pair is torn down
// when both directions are done or either side errors.
private final class ProxiedVoiceConnection: @unchecked Sendable {
    private let client: NWConnection
    private var upstream: NWConnection?
    private let queue: DispatchQueue
    private let onClose: (ObjectIdentifier, Bool) -> Void
    private var closed = false
    // Whether this connection counts toward keeping the server up.
    private var acquired = false
    private var finishedDirections = 0
    private static let chunkBytes = 64 * 1024
    // A request line longer than this is not one worth waiting for.
    private static let maxHeadBytes = 8 * 1024

    init(client: NWConnection, queue: DispatchQueue, onClose: @escaping (ObjectIdentifier, Bool) -> Void) {
        self.client = client
        self.queue = queue
        self.onClose = onClose
        client.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.close()
            default:
                break
            }
        }
    }

    /// Reads until the request line is complete (or the head limit is reached) and
    /// hands over everything read so far. A client that ends or errors first is closed.
    func readRequestHead(_ completion: @escaping (Data) -> Void) {
        readHead(accumulated: Data(), completion)
    }

    private func readHead(accumulated: Data, _ completion: @escaping (Data) -> Void) {
        client.receive(minimumIncompleteLength: 1, maximumLength: Self.maxHeadBytes) {
            [weak self] data, _, isComplete, error in
            guard let self, !self.closed else { return }
            var head = accumulated
            if let data { head.append(data) }
            if head.contains(UInt8(ascii: "\n")) || head.count >= Self.maxHeadBytes {
                completion(head)
            } else if error != nil || isComplete {
                self.close()
            } else {
                self.readHead(accumulated: head, completion)
            }
        }
    }

    func markAcquired() {
        acquired = true
    }

    func answerProbe() {
        client.send(
            content: VoiceProbeRequest.response,
            contentContext: .finalMessage,
            isComplete: true,
            completion: .contentProcessed { [weak self] _ in self?.close() }
        )
    }

    func attach(upstream: NWConnection, sending head: Data) {
        guard !closed else {
            upstream.cancel()
            return
        }
        self.upstream = upstream
        upstream.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                upstream.send(content: head, completion: .contentProcessed { [weak self] sendError in
                    guard let self, !self.closed else { return }
                    if sendError != nil {
                        self.close()
                        return
                    }
                    self.pump(from: self.client, to: upstream)
                    self.pump(from: upstream, to: self.client)
                })
            case .failed, .cancelled, .waiting:
                // A refused dial parks in .waiting and retries forever, which
                // would hold this connection's count and keep the server up.
                self.close()
            default:
                break
            }
        }
        upstream.start(queue: queue)
    }

    private func pump(from source: NWConnection, to destination: NWConnection) {
        source.receive(minimumIncompleteLength: 1, maximumLength: Self.chunkBytes) {
            [weak self] data, _, isComplete, error in
            guard let self, !self.closed else { return }
            if error != nil {
                self.close()
                return
            }
            if let data, !data.isEmpty {
                destination.send(content: data, completion: .contentProcessed { [weak self] sendError in
                    guard let self, !self.closed else { return }
                    if sendError != nil {
                        self.close()
                    } else if isComplete {
                        self.finishDirection(to: destination)
                    } else {
                        self.pump(from: source, to: destination)
                    }
                })
                return
            }
            if isComplete {
                self.finishDirection(to: destination)
            } else {
                self.pump(from: source, to: destination)
            }
        }
    }

    private func finishDirection(to destination: NWConnection) {
        destination.send(
            content: nil,
            contentContext: .finalMessage,
            isComplete: true,
            completion: .idempotent
        )
        finishedDirections += 1
        if finishedDirections == 2 { close() }
    }

    func close() {
        guard !closed else { return }
        closed = true
        client.stateUpdateHandler = nil
        upstream?.stateUpdateHandler = nil
        client.cancel()
        upstream?.cancel()
        onClose(ObjectIdentifier(self), acquired)
    }
}
