import Foundation
import Network
import os
import AgentDeskWire

// ADR-0019: live, no-storage device discovery. Dials a tailnet peer's offer
// port, sends a whois request, and waits briefly for a display-only identity
// reply. A peer that answers is an AgentDesk client currently ready to pair; one
// that refuses or times out simply is not, and is dropped from the picker. The
// reply is display-only and pre-auth; the signed handshake still gates pairing.
final class TailnetIdentityProber: @unchecked Sendable {
    var timeout: TimeInterval = 1.5

    func identify(ipv4: String, port: UInt16 = Config.offerPort) async -> DeviceIdentity? {
        await IdentityProbe(ipv4: ipv4, port: port, timeout: timeout).run()
    }
}

private final class IdentityProbe: @unchecked Sendable {
    private let ipv4: String
    private let port: UInt16
    private let timeout: TimeInterval
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).identity-probe")
    private let logger = Logger(subsystem: Config.logSubsystem, category: "identity-probe")
    private var parser = OfferPortFrameParser()
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<DeviceIdentity?, Never>?
    private var finished = false

    init(ipv4: String, port: UInt16, timeout: TimeInterval) {
        self.ipv4 = ipv4
        self.port = port
        self.timeout = timeout
    }

    func run() async -> DeviceIdentity? {
        await withCheckedContinuation { (continuation: CheckedContinuation<DeviceIdentity?, Never>) in
            self.continuation = continuation
            guard let nwPort = NWEndpoint.Port(rawValue: port),
                  let whois = try? OfferPortFrame.encode(JSONEncoder().encode(DeviceIdentityRequest())) else {
                continuation.resume(returning: nil)
                self.continuation = nil
                return
            }
            let connection = NWConnection(host: NWEndpoint.Host(ipv4), port: nwPort, using: .tcp)
            self.connection = connection
            // The timeout and all NWConnection callbacks run on the same serial
            // queue, so finish() resolves exactly once.
            queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish(nil)
            }
            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    connection.send(content: whois, completion: .contentProcessed { [weak self] error in
                        if error != nil {
                            self?.finish(nil)
                        } else {
                            self?.receive()
                        }
                    })
                case .failed, .cancelled:
                    self.finish(nil)
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }

    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                guard let bodies = try? self.parser.append(data) else {
                    self.finish(nil)
                    return
                }
                for body in bodies {
                    if case .identity(let identity) = OfferPortMessage.classify(body) {
                        self.finish(identity)
                        return
                    }
                }
            }
            if error != nil || isComplete {
                self.finish(nil)
                return
            }
            self.receive()
        }
    }

    private func finish(_ result: DeviceIdentity?) {
        guard !finished else { return }
        finished = true
        connection?.cancel()
        continuation?.resume(returning: result)
        continuation = nil
    }
}
