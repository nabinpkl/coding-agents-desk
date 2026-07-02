import Foundation
import Network
import os

// ADR-0034 crisp-repair: host side of the reliable graphics lane. The client opens the
// stream and tags it with a `.graphics` role marker; the host then owns it and pushes
// ADGC-framed OwnedGraphicsFrameEnvelope bytes (crisp tiles and revert directives). The
// stream is reliable and ordered, so envelopes must be enqueued in produce order; the
// send chain below serializes them so a slow send cannot reorder a later frame ahead of
// an earlier one.
@available(macOS 26.0, *)
final class GraphicsLaneServer: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "graphics-lane")
    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    // Tail of the serialized send chain plus a shared closed flag. Closing cancels the tail
    // and trips the flag; each queued send checks the flag before touching the stream, so a
    // queue that was already enqueued when close() ran drains without writing to a dead
    // stream (cancelling only the tail Task would leave its predecessors still sending).
    private struct SendChain { var tail: Task<Void, Never>?; var closed = false }
    private let sendChain = OSAllocatedUnfairLock(initialState: SendChain())

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
    }

    func send(_ envelope: OwnedGraphicsFrameEnvelope) {
        let bytes: Data
        do {
            bytes = try envelope.encode()
        } catch {
            logger.error("graphics lane encode failed fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
            return
        }
        sendChain.withLock { chain in
            guard !chain.closed else { return }
            let prior = chain.tail
            chain.tail = Task { [stream, logger, fingerprint, sendChain] in
                _ = await prior?.value
                guard !sendChain.withLock({ $0.closed }) else { return }
                do {
                    try await stream.send(bytes)
                } catch {
                    logger.error("graphics lane send failed fp=\(fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    func close() {
        sendChain.withLock { chain in
            chain.tail?.cancel()
            chain.tail = nil
            chain.closed = true
        }
    }
}
