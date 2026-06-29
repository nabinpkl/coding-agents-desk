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
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "graphics-lane")
    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private let sendChain = OSAllocatedUnfairLock<Task<Void, Never>?>(initialState: nil)

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
        sendChain.withLock { tail in
            let prior = tail
            tail = Task { [stream, logger, fingerprint] in
                _ = await prior?.value
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
            chain?.cancel()
            chain = nil
        }
    }
}
