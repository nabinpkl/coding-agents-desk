import Foundation
import Network
import os

final class OwnedMediaChannelServer: OwnedMediaChannelServing, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "owned-media-channel")
    private let connection: NWConnection
    private let fingerprint: DeviceFingerprint
    private let lock = NSLock()
    private var closed = false

    init(connection: NWConnection, fingerprint: DeviceFingerprint) {
        self.connection = connection
        self.fingerprint = fingerprint
        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("owned media channel state=\(String(describing: state), privacy: .public) fp=\(fingerprint.rawValue, privacy: .public)")
            switch state {
            case .cancelled, .failed:
                self?.markClosed()
            default:
                break
            }
        }
    }

    func send(_ envelope: OwnedMediaFrameEnvelope) async throws {
        guard !isClosed else {
            throw SessionRejected(reason: .unauthorized)
        }
        let data = try envelope.encode()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
            let context = NWConnection.ContentContext(identifier: "owned-media-frame", metadata: [metadata])
            connection.send(
                content: data,
                contentContext: context,
                isComplete: true,
                completion: .contentProcessed { error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
            )
        }
    }

    func close() {
        guard markClosed() else { return }
        connection.cancel()
    }

    private var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return closed
    }

    @discardableResult
    private func markClosed() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return false }
        closed = true
        return true
    }
}
