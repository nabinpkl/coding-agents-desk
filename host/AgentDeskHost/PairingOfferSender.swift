import Foundation
import Network
import os

enum PairingOfferSenderError: Error {
    case invalidEndpoint
    case connectionFailed(String)
    case timedOut
}

// ADR-0019: the host's only outbound pairing connection. Dials a chosen tailnet
// device on the offer port, pushes a single length-prefixed pairing offer, then
// closes. Plaintext over the tailnet is acceptable: WireGuard encrypts the peer
// hop, the host public key in the payload is already public, and the one-time
// nonce is pre-approval-gated, so a captured offer cannot pair a third device.
struct PairingOfferSender {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "pairing-offer")
    var timeout: TimeInterval = 10

    func send(offer: PairingPayload, toIPv4 ipv4: String, port: UInt16 = Config.offerPort) async throws {
        let frame = try OfferPortFrame.encode(offer.compactJSONData())
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw PairingOfferSenderError.invalidEndpoint
        }
        let connection = NWConnection(host: NWEndpoint.Host(ipv4), port: nwPort, using: .tcp)
        let queue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.pairing-offer")
        let logger = logger

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            // The resume guard ensures exactly one resume; a late-firing timeout
            // after a successful send simply no-ops, so the timeout needs no
            // cancellation (and we avoid capturing a non-Sendable work item).
            let guardState = ResumeGuard()

            queue.asyncAfter(deadline: .now() + timeout) {
                guard guardState.claim() else { return }
                connection.cancel()
                continuation.resume(throwing: PairingOfferSenderError.timedOut)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.send(content: frame, completion: .contentProcessed { error in
                        guard guardState.claim() else { return }
                        connection.cancel()
                        if let error {
                            continuation.resume(throwing: PairingOfferSenderError.connectionFailed("\(error)"))
                        } else {
                            logger.notice("offer frame sent bytes=\(frame.count, privacy: .public)")
                            continuation.resume()
                        }
                    })
                case .failed(let error):
                    guard guardState.claim() else { return }
                    connection.cancel()
                    continuation.resume(throwing: PairingOfferSenderError.connectionFailed("\(error)"))
                case .cancelled:
                    guard guardState.claim() else { return }
                    continuation.resume(throwing: PairingOfferSenderError.connectionFailed("cancelled"))
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }
}

// Resumes the offer continuation exactly once across the connection's callbacks
// and the timeout. Lock-guarded so it is safe to share into @Sendable closures.
private final class ResumeGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
