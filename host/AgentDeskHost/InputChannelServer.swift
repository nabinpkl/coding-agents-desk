import Foundation
import Network
import os

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
final class InputChannelServer: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "input-channel")
    private let connection: NWConnection
    private let fingerprint: DeviceFingerprint
    private var continuation: AsyncStream<NormalizedInput>.Continuation?

    let events: AsyncStream<NormalizedInput>

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
        connection.cancel()
    }

    func pushDesktopState(_ state: DesktopState) {
        let frame = DesktopStatePush(state: state)
        let data: Data
        do {
            data = try JSONEncoder().encode(frame)
        } catch {
            logger.error("desktop-state encode failed: \(String(describing: error), privacy: .public)")
            return
        }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(
            identifier: "desktop-state",
            metadata: [metadata]
        )
        connection.send(
            content: data,
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { [weak self] error in
                if let error {
                    self?.logger.error("desktop-state send failed: \(String(describing: error), privacy: .public)")
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

    private func dispatch(data: Data) {
        do {
            let frame = try JSONDecoder().decode(InputChannelEvent.self, from: data)
            guard frame.type == "input-event" else {
                logger.error("input-channel non-event frame after hello: type=\(frame.type, privacy: .public)")
                return
            }
            continuation?.yield(frame.event)
        } catch {
            logger.error("input-channel event decode failed: \(String(describing: error), privacy: .public)")
        }
    }
}
