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
// connection itself. This listener is that signal: each accepted connection asks
// for a backend (which starts the server if none is running), is piped to it
// byte for byte, and reports when it closes, which is what lets the supervisor
// stop the server once nothing is connected.
//
// Loopback only, like the server it fronts: the listener binds 127.0.0.1 and
// nothing else.
final class VoiceSidecarActivationProxy: @unchecked Sendable {
    /// Returns the backend's base URL once it answers, or nil when it could not be
    /// started. Every call is balanced by exactly one `release`.
    typealias Acquire = @Sendable () async -> URL?
    typealias Release = @Sendable () -> Void

    private let port: UInt16
    private let acquire: Acquire
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
        release: @escaping Release,
        onReady: @escaping @Sendable (URL) -> Void
    ) {
        self.port = port
        self.acquire = acquire
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
        let connection = ProxiedVoiceConnection(client: client, queue: queue) { [weak self] id in
            // Runs on `queue`, exactly once per connection.
            self?.connections.removeValue(forKey: id)
            release()
        }
        connections[ObjectIdentifier(connection)] = connection
        client.start(queue: queue)
        let acquire = self.acquire
        let queue = self.queue
        let logger = self.logger
        Task {
            let backend = await acquire()
            queue.async {
                guard let backend,
                      let rawPort = backend.port,
                      let backendPort = NWEndpoint.Port(rawValue: UInt16(rawPort))
                else {
                    logger.error("voice activation proxy has no backend; closing connection")
                    connection.close()
                    return
                }
                connection.attach(upstream: NWConnection(
                    host: .ipv4(.loopback),
                    port: backendPort,
                    using: .tcp
                ))
            }
        }
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
    private let onClose: (ObjectIdentifier) -> Void
    private var closed = false
    private var finishedDirections = 0
    private static let chunkBytes = 64 * 1024

    init(client: NWConnection, queue: DispatchQueue, onClose: @escaping (ObjectIdentifier) -> Void) {
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

    func attach(upstream: NWConnection) {
        guard !closed else {
            upstream.cancel()
            return
        }
        self.upstream = upstream
        upstream.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.pump(from: self.client, to: upstream)
                self.pump(from: upstream, to: self.client)
            case .failed, .cancelled:
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
        onClose(ObjectIdentifier(self))
    }
}
