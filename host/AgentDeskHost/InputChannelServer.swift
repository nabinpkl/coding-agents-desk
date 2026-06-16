import Foundation
import Network
import os

protocol InputChannelServing: AnyObject, Sendable {
    var events: AsyncStream<NormalizedInput> { get }
    var configHandler: ((ClientConfig) -> Void)? { get set }
    var interactionHintHandler: ((InteractionHint) -> Void)? { get set }

    func close()
    func pushDesktopState(_ state: DesktopState)
    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow])
    func pushAgentSay(_ push: AgentSayPush)
    func pushCursor(_ push: CursorImagePush)
}

// R11 wire shape: a server-pushed DesktopStatePush frame travels over
// the same input WSS as the client-initiated InputChannelEvent frames.
// The WS is bidirectional already; only the client->host direction was
// previously wired. The push is one frame per emit (state on attach,
// state after every successful server-side Spaces switch).

// ADR-0005: per-session input channel server. Owns one NWConnection
// that has already been classified by PairingSignalingServer as an
// `input-hello`-fronted connection and bound to an active session.
// Drains subsequent `InputChannelEvent` frames into an AsyncStream that
// AppDelegate plumbs into the InputDispatcher's serial queue.
//
// One instance per active session. SessionRegistry owns the lifecycle:
// on session end, `close()` is called which cancels the underlying
// NWConnection; the inbound continuation finishes, the consuming Task
// drops, the dispatcher stops receiving events for that session.
final class InputChannelServer: InputChannelServing, @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "input-channel")
    private let connection: NWConnection
    private let fingerprint: DeviceFingerprint
    private var continuation: AsyncStream<NormalizedInput>.Continuation?

    let events: AsyncStream<NormalizedInput>

    // ADR-0006: clients opt in to thumbnail capture via a `client-config`
    // frame after the channel is open. AppDelegate sets this handler on
    // attach; the server itself only routes the frame.
    var configHandler: ((ClientConfig) -> Void)?
    // Set by AppDelegate on attach; routes scroll/interaction hints to the
    // session's MediaTransport for quality switching.
    var interactionHintHandler: ((InteractionHint) -> Void)?

    init(connection: NWConnection, fingerprint: DeviceFingerprint) {
        self.connection = connection
        self.fingerprint = fingerprint
        var captured: AsyncStream<NormalizedInput>.Continuation?
        self.events = AsyncStream { continuation in
            captured = continuation
        }
        self.continuation = captured

        connection.stateUpdateHandler = { [weak self] state in
            self?.logger.notice("input-channel state=\(String(describing: state), privacy: .public) fp=\(fingerprint.rawValue, privacy: .public)")
            switch state {
            case .cancelled, .failed:
                self?.continuation?.finish()
                self?.continuation = nil
            default:
                break
            }
        }
        receiveNext()
    }

    func close() {
        continuation?.finish()
        continuation = nil
        configHandler = nil
        interactionHintHandler = nil
        connection.cancel()
    }

    func pushDesktopState(_ state: DesktopState) {
        sendCodableFrame(DesktopStatePush(state: state), identifier: "desktop-state")
    }

    func pushAgentSay(_ push: AgentSayPush) {
        sendCodableFrame(push, identifier: "agent-say")
    }

    // Cursor-image mirror rides its own frame, pushed on shape change and
    // on attach. CursorMonitor produces the push; the server only routes.
    func pushCursor(_ push: CursorImagePush) {
        sendCodableFrame(push, identifier: "cursor")
    }

    // ADR-0006: thumbnail bytes ride their own frame so the periodic
    // refresh cadence doesn't pollute the event-driven DesktopState
    // push path. Sent only when SpaceThumbnailProvider has produced a
    // result; an empty dict is a valid "clear" signal.
    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow] = [:]) {
        var stringKeyed: [String: String] = [:]
        stringKeyed.reserveCapacity(thumbnails.count)
        for (spaceId, jpeg) in thumbnails {
            stringKeyed[String(spaceId)] = jpeg.base64EncodedString()
        }
        var topWindowsKeyed: [String: SpaceTopWindow] = [:]
        topWindowsKeyed.reserveCapacity(topWindows.count)
        for (spaceId, info) in topWindows {
            topWindowsKeyed[String(spaceId)] = info
        }
        sendCodableFrame(
            ThumbnailsPush(
                thumbnails: stringKeyed,
                topWindows: topWindowsKeyed.isEmpty ? nil : topWindowsKeyed
            ),
            identifier: "thumbnails-push"
        )
    }

    private func sendCodableFrame<T: Encodable>(_ frame: T, identifier: String) {
        let data: Data
        do {
            data = try JSONEncoder().encode(frame)
        } catch {
            logger.error("\(identifier, privacy: .public) encode failed: \(String(describing: error), privacy: .public)")
            return
        }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(
            identifier: identifier,
            metadata: [metadata]
        )
        connection.send(
            content: data,
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { [weak self] error in
                if let error {
                    self?.logger.error("\(identifier, privacy: .public) send failed: \(String(describing: error), privacy: .public)")
                }
            }
        )
    }

    private func receiveNext() {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let error {
                self.logger.error("input-channel receive error: \(String(describing: error), privacy: .public)")
                self.close()
                return
            }
            guard let data else {
                self.logger.notice("input-channel peer closed")
                self.close()
                return
            }
            self.dispatch(data: data)
            self.receiveNext()
        }
    }

    // Two inbound frame types after the hello: input-event (the bulk of
    // traffic) and client-config (opt-in toggles). Peek at the `t`
    // discriminator before committing to a struct so an unknown frame
    // gets logged-and-dropped rather than tearing down the channel.
    private func dispatch(data: Data) {
        guard let header = try? JSONDecoder().decode(InboundFrameHeader.self, from: data) else {
            logger.error("input-channel frame missing type discriminator")
            return
        }
        switch header.type {
        case "input-event":
            do {
                let frame = try JSONDecoder().decode(InputChannelEvent.self, from: data)
                continuation?.yield(frame.event)
            } catch {
                logger.error("input-channel event decode failed: \(String(describing: error), privacy: .public)")
            }
        case "client-config":
            do {
                let frame = try JSONDecoder().decode(ClientConfig.self, from: data)
                configHandler?(frame)
            } catch {
                logger.error("client-config decode failed: \(String(describing: error), privacy: .public)")
            }
        case "interaction-hint":
            do {
                let frame = try JSONDecoder().decode(InteractionHint.self, from: data)
                interactionHintHandler?(frame)
            } catch {
                logger.error("interaction-hint decode failed: \(String(describing: error), privacy: .public)")
            }
        default:
            logger.notice("input-channel unknown frame type=\(header.type, privacy: .public)")
        }
    }

    // Minimal envelope for discriminator peek. Mirrors the `t` key the
    // compact-keyed frame structs use.
    private struct InboundFrameHeader: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }
}
