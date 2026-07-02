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

    // ADR-0046: host-pushed diagnostic status (extension reachable, recording tab) for the Browser
    // status line. Delivered on the main actor; does not affect the batch stream.
    var onStatus: (@MainActor (DomStatus) -> Void)?

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
                    // Typed discrimination on the `t` tag: a batch is forwarded verbatim; an
                    // ADR-0046 dom-status updates the diagnostic line without touching the stream;
                    // anything else (e.g. the host's SessionRejected when its flag is off) closes
                    // the lane cleanly without tearing down the session.
                    guard let disc = try? JSONDecoder().decode(DomLaneFrameTag.self, from: frame.payload) else {
                        logger.notice("dom lane closed or undecodable frame; stopping")
                        return
                    }
                    switch disc.type {
                    case "dom-batch":
                        guard let json = String(data: frame.payload, encoding: .utf8) else { return }
                        let handler = onBatch
                        await MainActor.run { handler?(json) }
                    case "dom-status":
                        guard let status = try? JSONDecoder().decode(DomStatus.self, from: frame.payload) else { continue }
                        let handler = onStatus
                        await MainActor.run { handler?(status) }
                    default:
                        logger.notice("dom lane non-content frame (\(disc.type, privacy: .public)); stopping")
                        return
                    }
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

    // ADR-0045: pause/resume DOM capture at the source. Sent UP the .dom lane; the host forwards it
    // to the extension, which stops/starts rrweb recording (restart emits a fresh full snapshot).
    // Guarded on the lane having been started (announce sent) so a capture frame never races ahead
    // of the role announce the host reads first.
    func setCapture(_ on: Bool) {
        guard task != nil else { return }
        let cmd = DomCaptureCommand(on: on)
        guard let payload = try? JSONEncoder().encode(cmd) else { return }
        Task { [stream, logger] in
            do {
                try await QuicSessionStreamIO.sendPayload(payload, role: .dom, on: stream)
            } catch {
                logger.notice("dom lane capture send failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }
}

// Minimal decode of just the `t` discriminator, so the receive loop can branch on frame kind before
// committing to a full envelope decode.
private struct DomLaneFrameTag: Decodable {
    let type: String
    enum CodingKeys: String, CodingKey { case type = "t" }
}
