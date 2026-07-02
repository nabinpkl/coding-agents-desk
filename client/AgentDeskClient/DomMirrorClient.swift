import Foundation
import Network
import OSLog

// ADR-0038 client side of the DOM lane. Opens by announcing the .dom role (one 1-byte frame the
// host reads to attach its pusher), then reads host-pushed QuicSessionStreamFrame(.dom) frames and
// forwards each rrweb batch (the frame payload as JSON text) to the replay surface. Decoupled from
// the media transport: a lane failure stops this loop but never tears down the session.
@available(iOS 26.0, *)
final class DomMirrorClient: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "dom-mirror-client")
    private let stream: QUIC.Stream<QUICStream>
    private var task: Task<Void, Never>?

    // Set by the UI layer before start(): each received batch (raw JSON) is delivered here on the
    // main actor, ready to hand to DomMirrorSurface.deliver(rawJSON:).
    var onBatch: (@MainActor (String) -> Void)?

    init(stream: QUIC.Stream<QUICStream>) { self.stream = stream }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            guard let self else { return }
            do {
                try await QuicSessionStreamIO.sendPayload(Data([0]), role: .dom, on: stream)
                logger.notice("dom lane announced")
            } catch {
                logger.notice("dom lane announce failed: \(String(describing: error), privacy: .public)")
                return
            }
            while !Task.isCancelled {
                do {
                    let frame = try await QuicSessionStreamIO.receiveFrame(on: stream)
                    guard frame.role == .dom else { continue }
                    // Typed discrimination: a real batch decodes as a DomBatchEnvelope (type
                    // "dom-batch"); a control frame -- e.g. the host's SessionRejected when its own
                    // flag is off -- does not. Forward only batches (the raw JSON, which still carries
                    // ev); stop cleanly on anything else without touching the session.
                    guard let envelope = try? JSONDecoder().decode(DomBatchEnvelope.self, from: frame.payload),
                          envelope.type == "dom-batch",
                          let json = String(data: frame.payload, encoding: .utf8) else {
                        logger.notice("dom lane closed or non-batch frame; stopping")
                        return
                    }
                    let handler = onBatch
                    await MainActor.run { handler?(json) }
                } catch {
                    logger.notice("dom lane receive ended: \(String(describing: error), privacy: .public)")
                    return
                }
            }
        }
    }

    // ADR-0040: send a tap (page CSS-pixel coords, already mapped by the replayer) UP the .dom lane.
    // The host reads it and relays it to the extension for trusted dispatch via chrome.debugger.
    func sendTap(x: Double, y: Double) {
        let cmd = DomInputCommand(x: x, y: y)
        guard let payload = try? JSONEncoder().encode(cmd) else { return }
        Task { [stream, logger] in
            do {
                try await QuicSessionStreamIO.sendPayload(payload, role: .dom, on: stream)
            } catch {
                logger.notice("dom lane tap send failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}
