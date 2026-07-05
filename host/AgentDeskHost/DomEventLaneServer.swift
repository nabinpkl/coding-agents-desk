import Foundation
import Network
import os

// ADR-0038 host side of the reliable DOM-event lane. The client opens the stream and tags it with
// a `.dom` role marker; the host then owns it and pushes checkout-framed rrweb batches. Modeled on
// GraphicsLaneServer: the stream is reliable and ordered, so batches must be enqueued in produce
// order; the serialized send chain below prevents a slow send from reordering a later batch ahead
// of an earlier one. Each batch is framed as one QuicSessionStreamFrame(role: .dom) so the client
// reads it back with the same receiveFrame path it already uses.
@available(macOS 26.0, *)
final class DomEventLaneServer: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "dom-lane")
    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    // Tail of the serialized send chain plus a shared closed flag; see GraphicsLaneServer for the
    // rationale (closing cancels the tail and trips the flag so queued sends drain without writing
    // to a dead stream).
    private struct SendChain { var tail: Task<Void, Never>?; var closed = false }
    private let sendChain = OSAllocatedUnfairLock(initialState: SendChain())

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
    }

    // Send one rrweb batch (the raw newline-free JSON the shim forwarded) down the lane.
    func send(_ payload: Data) {
        let bytes: Data
        do {
            bytes = try QuicSessionStreamFrame.encode(role: .dom, payload: payload)
        } catch {
            logger.error("dom lane encode failed fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
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
                    logger.error("dom lane send failed fp=\(fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)")
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
