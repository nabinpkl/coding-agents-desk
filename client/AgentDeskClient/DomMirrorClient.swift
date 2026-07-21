import Foundation
import Network
import os
import OSLog
import AgentDeskWire
import BrowserProjection

enum DomLanePayloadClassifier {
    enum Classification: Equatable {
        case batch
        case projectionMetadata
        case status(DomStatus)
        case invalid
    }

    static func classify(_ payload: Data) -> Classification {
        guard let tag = try? JSONDecoder().decode(DomLaneFrameTag.self, from: payload) else {
            return .invalid
        }
        switch tag.type {
        case "dom-batch":
            return .batch
        case "browser-state":
            do {
                let state = try JSONDecoder().decode(BrowserProjectionState.self, from: payload)
                try state.validate()
                return .projectionMetadata
            } catch {
                return .invalid
            }
        case "projection-host":
            return (try? JSONDecoder().decode(BrowserProjectionHostState.self, from: payload)) == nil
                ? .invalid : .projectionMetadata
        case "dom-status":
            guard let status = try? JSONDecoder().decode(DomStatus.self, from: payload) else {
                return .invalid
            }
            return .status(status)
        default:
            return .invalid
        }
    }
}

// ADR-0038/0064 client side of the DOM lane. Opens by announcing the .dom role (one 1-byte frame the
// host reads to attach its pusher), then reads host-pushed QuicSessionStreamFrame(.dom) frames and
// forwards validated projection metadata and rrweb batches to the shared browser surface. Decoupled
// from the media transport: a lane failure stops this loop but never tears down the session.
@available(iOS 26.0, *)
final class DomMirrorClient: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "dom-mirror-client")
    private let stream: QUIC.Stream<QUICStream>
    private var task: Task<Void, Never>?

    // ADR-0047: all client->host writes on the .dom stream go through this serialized chain. Tap,
    // scroll, and emulate commands are fire-and-forget from the main actor, and scroll fires up to
    // once per animation frame; without serialization those concurrent stream.send calls interleave
    // their bytes on the one QUIC stream, so the host reads a corrupted frame and its receive loop
    // ends with `malformed` -- killing the whole reverse channel. Each enqueued send awaits the prior,
    // mirroring the host's DomEventLaneServer send chain, so frames are written whole and in order.
    private let sendChain = OSAllocatedUnfairLock<Task<Void, Never>?>(initialState: nil)

    // Set by the UI layer before start(): each projection payload (raw JSON) is delivered here on the
    // main actor, ready to hand to DomMirrorSurface.deliver(rawJSON:). `isBatch` keeps diagnostic
    // freshness accounting separate from metadata updates without reparsing JSON in the UI layer.
    var onProjectionPayload: (@MainActor (_ json: String, _ isBatch: Bool) -> Void)?

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
                    let frame = try await QuicSessionStreamIO.receiveFrame(on: stream, expectedRole: .dom)
                    guard frame.role == .dom else { continue }
                    // Typed discrimination on the `t` tag: a batch is forwarded verbatim; an
                    // ADR-0046 dom-status updates the diagnostic line without touching the stream;
                    // anything else (e.g. the host's SessionRejected when its flag is off) closes
                    // the lane cleanly without tearing down the session.
                    let classification = DomLanePayloadClassifier.classify(frame.payload)
                    switch classification {
                    case .batch, .projectionMetadata:
                        guard let json = String(data: frame.payload, encoding: .utf8) else { return }
                        let handler = onProjectionPayload
                        let isBatch = classification == .batch
                        await MainActor.run { handler?(json, isBatch) }
                    case .status(let status):
                        let handler = onStatus
                        await MainActor.run { handler?(status) }
                    case .invalid:
                        logger.notice("dom lane invalid or incompatible frame; stopping")
                        return
                    }
                } catch {
                    logger.notice("dom lane receive ended: \(String(describing: error), privacy: .public)")
                    return
                }
            }
        }
    }

    // Serialize one client->host frame onto the .dom stream: chain it after the prior send so the two
    // never interleave their bytes on the wire (see sendChain). Fire-and-forget; errors are logged.
    //
    // ADR-0047 scroll diagnostic: each send logs `waitedUs` (time it sat behind the prior send in the
    // serialized chain) and `sendUs` (the QUIC write itself). Under a 60Hz scroll drag, a growing
    // waitedUs means the serialization -- the a0f5a44 fix -- is the head-of-line bottleneck (frames
    // backing up faster than the stream drains); a growing sendUs means the QUIC write is the cost.
    private func enqueueSend(_ payload: Data, label: String) {
        let enqueuedNs = DispatchTime.now().uptimeNanoseconds
        sendChain.withLock { tail in
            let prior = tail
            tail = Task { [stream, logger] in
                _ = await prior?.value
                let startNs = DispatchTime.now().uptimeNanoseconds
                do {
                    try await QuicSessionStreamIO.sendPayload(payload, role: .dom, on: stream)
                    let doneNs = DispatchTime.now().uptimeNanoseconds
                    let waitedUs = (startNs &- enqueuedNs) / 1_000
                    let sendUs = (doneNs &- startNs) / 1_000
                    logger.notice("dom lane send label=\(label, privacy: .public) bytes=\(payload.count) waitedUs=\(waitedUs) sendUs=\(sendUs)")
                } catch {
                    logger.notice("dom lane send failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    // ADR-0040: send a tap (page CSS-pixel coords, already mapped by the replayer) UP the .dom lane.
    // The host reads it and relays it to the extension for trusted dispatch via chrome.debugger.
    func sendTap(x: Double, y: Double) {
        let cmd = DomInputCommand(x: x, y: y)
        guard let payload = try? JSONEncoder().encode(cmd) else { return }
        enqueueSend(payload, label: "tap")
    }

    // ADR-0047: scroll-drive-back. Send a scroll gesture (page CSS-pixel anchor + finger movement
    // delta, already mapped by the replayer) UP the .dom lane. The host relays it to the extension,
    // which drives the REAL tab to scroll via chrome.debugger, so dynamic (lazy/infinite) pages load
    // because it is always the live page. Serialized (see enqueueSend): scroll fires ~once per frame,
    // so its sends must not race each other on the stream.
    func sendScroll(x: Double, y: Double, dx: Double, dy: Double) {
        let cmd = DomScrollCommand(x: x, y: y, dx: dx, dy: dy)
        guard let payload = try? JSONEncoder().encode(cmd) else { return }
        enqueueSend(payload, label: "scroll dx=\(Int(dx)) dy=\(Int(dy))")
    }

    func selectWindow(_ windowId: Int, generation: Int) {
        guard task != nil else { return }
        let command = BrowserProjectionSelectWindowCommand(
            windowId: windowId,
            generation: generation
        )
        guard let payload = try? JSONEncoder().encode(command) else { return }
        enqueueSend(payload, label: "select-window")
    }

    func selectTab(_ windowId: Int, tabId: Int, generation: Int) {
        guard task != nil else { return }
        let command = BrowserProjectionSelectTabCommand(
            windowId: windowId,
            tabId: tabId,
            generation: generation
        )
        guard let payload = try? JSONEncoder().encode(command) else { return }
        enqueueSend(payload, label: "select-tab")
    }

    // ADR-0045: pause/resume DOM capture at the source. Sent UP the .dom lane; the host forwards it
    // to the extension, which stops/starts rrweb recording (restart emits a fresh full snapshot).
    // Guarded on the lane having been started (announce sent) so a capture frame never races ahead
    // of the role announce the host reads first.
    func setCapture(_ on: Bool) {
        guard task != nil else { return }
        let cmd = DomCaptureCommand(on: on)
        guard let payload = try? JSONEncoder().encode(cmd) else { return }
        enqueueSend(payload, label: "capture")
    }

    // ADR-0048: toggle host-side device emulation (true mobile). Sent UP the .dom lane; the host
    // forwards it to the extension, which device-emulates the recorded tab and resnapshots. The
    // authoritative emulation state comes BACK via dom-status (DomStatus.emulated), so the client's
    // control self-corrects; this call is just the request. Guarded on the lane having been started.
    func setEmulate(_ mobile: Bool) {
        guard task != nil else { return }
        let cmd = DomEmulateCommand(mobile: mobile)
        guard let payload = try? JSONEncoder().encode(cmd) else { return }
        enqueueSend(payload, label: "emulate")
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
