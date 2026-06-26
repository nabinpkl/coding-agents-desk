import Foundation
import Network
import os

// ADR-0025 motion carrier transport (host side). Owns a dedicated QUIC listener whose
// connections carry ONLY datagrams (isDatagram = true), separate from the reliable
// graphics group. The encode pump hands packetized HEVC frames to send(_:); the client's
// keyframe requests arrive as JSON datagrams and are forwarded via onControlMessage.
//
// This replaces the first ADR-0025 wiring that sent video via group.send on the reliable
// graphics NWConnectionGroup, which Network.framework cancelled (POSIX 89) so nothing was
// delivered. The dedicated isDatagram connection is the proven pre-0022 mechanism.
//
// Single-client assumption: the latest accepted datagram connection is treated as active,
// mirroring activeGraphicsConnectionId. The packet HMAC (QUIC already secures the channel)
// guards integrity. A multi-client upgrade would carry a session id in a first datagram.
final class OwnedMediaVideoDatagramServer: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media-datagram")
    private let parameters: NWParameters
    private let port: NWEndpoint.Port
    private let queue: DispatchQueue
    private let pacer: OwnedMediaDatagramSendPacer
    private let onControlMessage: @Sendable (OwnedMediaControlMessage) -> Void

    private let lock = NSLock()
    private var listener: NWListener?
    private var connection: NWConnection?
    private var sendErrors = 0
    private var connectionMisses = 0
    private var lastSendError: String?

    init(
        parameters: NWParameters,
        port: NWEndpoint.Port,
        queue: DispatchQueue,
        pacer: OwnedMediaDatagramSendPacer,
        onControlMessage: @escaping @Sendable (OwnedMediaControlMessage) -> Void
    ) {
        self.parameters = parameters
        self.port = port
        self.queue = queue
        self.pacer = pacer
        self.onControlMessage = onControlMessage
    }

    func start() throws {
        let listener = try NWListener(using: parameters, on: port)
        let portRaw = port.rawValue
        listener.newConnectionHandler = { [weak self] connection in
            self?.acceptConnection(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media datagram listener state=\(String(describing: state), privacy: .public) port=\(portRaw, privacy: .public)")
            if case .failed(let error) = state {
                self?.logger.error("owned media datagram listener failed: \(String(describing: error), privacy: .public)")
            }
        }
        lock.withLock { self.listener = listener }
        listener.start(queue: queue)
    }

    func stop() {
        let (listener, connection) = lock.withLock { () -> (NWListener?, NWConnection?) in
            let l = self.listener
            let c = self.connection
            self.listener = nil
            self.connection = nil
            return (l, c)
        }
        listener?.cancel()
        connection?.cancel()
    }

    // Send a frame's already-packetized datagrams, paced into bursts so a large frame
    // does not flood the send buffer in one tight loop.
    func send(_ packets: [Data]) {
        let connection = lock.withLock { self.connection }
        guard let connection else {
            lock.withLock { connectionMisses &+= 1 }
            return
        }
        let bursts = pacer.bursts(packetCount: packets.count)
        for (burstIndex, range) in bursts.enumerated() {
            let slice = Array(packets[range])
            let delayNanos = pacer.pauseNanos * UInt64(burstIndex)
            if delayNanos == 0 {
                sendBurst(slice, on: connection)
            } else {
                queue.asyncAfter(deadline: .now() + .nanoseconds(Int(delayNanos))) { [weak self] in
                    self?.sendBurst(slice, on: connection)
                }
            }
        }
    }

    func diagnosticsSnapshot() -> (connectionMisses: Int, sendErrors: Int, lastError: String?) {
        lock.withLock { (connectionMisses, sendErrors, lastSendError) }
    }

    private func sendBurst(_ packets: [Data], on connection: NWConnection) {
        for data in packets {
            connection.send(content: data, completion: .contentProcessed { [weak self] error in
                guard let self, let error else { return }
                self.lock.withLock {
                    self.sendErrors &+= 1
                    self.lastSendError = String(describing: error)
                }
            })
        }
    }

    private func acceptConnection(_ connection: NWConnection) {
        let previous = lock.withLock { () -> NWConnection? in
            let previous = self.connection
            self.connection = connection
            return previous
        }
        previous?.cancel()
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media datagram connection state=\(String(describing: state), privacy: .public)")
        }
        connection.start(queue: queue)
        receiveControl(on: connection)
        logger.notice("owned media datagram connection accepted")
    }

    // Inbound datagrams on this connection are client -> host control (keyframe request),
    // sent as raw JSON. Re-arm after each so the receive loop continues for the session.
    private func receiveControl(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, !data.isEmpty,
               let message = try? JSONDecoder().decode(OwnedMediaControlMessage.self, from: data) {
                self.onControlMessage(message)
            }
            if error == nil {
                self.receiveControl(on: connection)
            }
        }
    }
}
