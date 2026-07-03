import Foundation
import Network
import os

// ADR-0038 host side of the reliable DOM-event lane. The client opens the stream and tags it with
// a `.dom` role marker; the host then owns it and pushes checkout-framed rrweb batches. Modeled on
// GraphicsLaneServer: the stream is reliable and ordered, so batches must be enqueued in produce
// order; the serialized send chain below prevents a slow send from reordering a later batch ahead
// of an earlier one. Each batch is framed as one QuicSessionStreamFrame(role: .dom) so the client
// reads it back with the same receiveFrame path it already uses.
// Minimal envelope for discriminating client->host control frames by their `t` tag without
// committing to a full command shape (each command decodes its own fields downstream / in the
// extension).
private struct DomLaneControlEnvelope: Decodable {
    let type: String
    enum CodingKeys: String, CodingKey { case type = "t" }
}

// Testable seam: true iff the payload is a recognized client->host DOM control command that the
// lane should forward verbatim to the bridge -- an ADR-0040 `dom-input` tap, an ADR-0045
// `dom-capture` pause/resume, or an ADR-0047 `dom-scroll` drive-back. Anything else (host batch
// echoed back, malformed line) is dropped so the bridge only ever relays recognized commands to the
// extension.
func isForwardableDomControl(_ payload: Data) -> Bool {
    guard let env = try? JSONDecoder().decode(DomLaneControlEnvelope.self, from: payload) else {
        return false
    }
    return env.type == "dom-input" || env.type == "dom-capture" || env.type == "dom-scroll"
}

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
    private let receiveTask = OSAllocatedUnfairLock<Task<Void, Never>?>(initialState: nil)

    // ADR-0040: raw client tap frames ({t:"dom-input",...}) read off the lane, forwarded verbatim to
    // the bridge (which relays them to the extension). The lane stays send-only for DOM batches; this
    // is the one client->host direction, kept on the DOM lane so DOM input never touches the Mac
    // input path.
    var onInput: ((Data) -> Void)?

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
    }

    // Begin reading client tap frames. The role announce was already consumed by the signaling
    // server, so the first frame here is client content. Idempotent.
    func startReceiving() {
        receiveTask.withLock { task in
            guard task == nil else { return }
            task = Task { [weak self] in
                guard let self else { return }
                while !(self.sendChain.withLock { $0.closed }) {
                    do {
                        let frame = try await QuicSessionStreamIO.receiveFrame(on: self.stream)
                        guard frame.role == .dom,
                              isForwardableDomControl(frame.payload) else { continue }
                        self.onInput?(frame.payload)
                    } catch {
                        self.logger.notice("dom lane receive ended: \(String(describing: error), privacy: .public)")
                        return
                    }
                }
            }
        }
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
        receiveTask.withLock { task in
            task?.cancel()
            task = nil
        }
    }
}
