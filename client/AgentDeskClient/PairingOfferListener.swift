import Foundation
import Network
import os
import AgentDeskWire

// ADR-0019: listens on the offer port for a Mac-pushed pairing offer while the
// app is foregrounded and unpaired. The Mac dials this iPhone over the tailnet
// (inbound TCP over the utun interface) and writes one length-prefixed offer;
// the listener decodes it and hands the payload to onOffer on the main queue.
//
// PRIMARY RISK (ADR-0019): inbound delivery over utun to a foregrounded,
// sandboxed iOS app is unproven. If a device run shows offers never arrive, the
// fallback is to have the iPhone dial the Mac instead.
final class PairingOfferListener: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "pairing-offer")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: OfferConnectionState] = [:]

    // Called on the main queue with each decoded offer.
    var onOffer: ((PairingPayload) -> Void)?

    // ADR-0019: this device's display-only identity, replied to host whois probes
    // so the Mac picker can list this device by name. Snapshotted by the owner
    // when the listener starts.
    var localIdentity: DeviceIdentity?
    var storedPairingRecordProvider: (() -> StoredPairingRecord?)?
    var diagnosticsResponseProvider: ((DiagnosticsRequest) -> Result<ClientDiagnosticsPreparedResponse, DiagnosticsError>)?
    var screenshotResponseProvider: ((ClientScreenshotRequest) async -> Result<PreparedClientScreenshot, ClientScreenshotError>)?
    var screenshotDeliveryHandler: (@MainActor @Sendable () -> Void)?

    func start(port: UInt16 = Config.offerPort) {
        guard listener == nil else { return }
        do {
            let nwPort = NWEndpoint.Port(rawValue: port) ?? .any
            let listener = try NWListener(using: .tcp, on: nwPort)
            listener.stateUpdateHandler = { [weak self] state in
                self?.logger.notice("offer listener state: \(String(describing: state), privacy: .public)")
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.handleNewConnection(connection)
            }
            listener.start(queue: .main)
            self.listener = listener
            logger.notice("offer listener started on port \(Int(port), privacy: .public)")
        } catch {
            logger.error("offer listener start failed: \(String(describing: error), privacy: .public)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for state in connections.values {
            state.connection.cancel()
        }
        connections.removeAll()
    }

    private func handleNewConnection(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        let state = OfferConnectionState(connection: connection)
        connections[id] = state
        connection.stateUpdateHandler = { [weak self] connectionState in
            switch connectionState {
            case .cancelled, .failed:
                self?.connections.removeValue(forKey: id)
            default:
                break
            }
        }
        receive(on: connection, state: state)
        connection.start(queue: .main)
    }

    private func receive(on connection: NWConnection, state: OfferConnectionState) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                do {
                    for body in try state.parser.append(data) {
                        switch OfferPortMessage.classify(body) {
                        case .offer(let payload):
                            self.logger.notice("offer received")
                            self.onOffer?(payload)
                            connection.cancel()
                            return
                        case .whois:
                            self.logger.notice("whois received")
                            self.respondToWhois(on: connection)
                            return
                        case .diagnosticsRequest(let request):
                            self.logger.notice("diagnostics request received")
                            self.respondToDiagnosticsRequest(request, on: connection)
                            return
                        case .screenshotRequest(let request):
                            self.logger.notice("client screenshot request received")
                            self.respondToScreenshotRequest(request, on: connection)
                            return
                        case .diagnosticsSummary, .diagnosticsChunk, .diagnosticsError,
                             .screenshotManifest, .screenshotChunk, .screenshotError:
                            connection.cancel()
                            return
                        case .identity, .unknown:
                            connection.cancel()
                            return
                        }
                    }
                } catch {
                    self.logger.error("offer-port parse failed: \(String(describing: error), privacy: .public)")
                    connection.cancel()
                    return
                }
            }
            if error != nil || isComplete {
                connection.cancel()
                return
            }
            self.receive(on: connection, state: state)
        }
    }

    // ADR-0019: reply to a host whois probe with this device's display identity,
    // then close. Lets the Mac picker list this device by name pre-pairing.
    private func respondToWhois(on connection: NWConnection) {
        guard let identity = localIdentity else {
            connection.cancel()
            return
        }
        do {
            let frame = try OfferPortFrame.encode(try JSONEncoder().encode(identity))
            connection.send(content: frame, completion: .contentProcessed { [weak self] _ in
                self?.logger.notice("identity replied")
                connection.cancel()
            })
        } catch {
            connection.cancel()
        }
    }

    private func respondToDiagnosticsRequest(_ request: SignedDiagnosticsRequest, on connection: NWConnection) {
        guard let record = storedPairingRecordProvider?(),
              ClientDiagnostics.shared.validateFallbackRequest(request, record: record),
              let responseProvider = diagnosticsResponseProvider else {
            sendFrames([
                DiagnosticsError(requestId: request.requestId, reason: "unauthorized")
            ], on: connection) {
                connection.cancel()
            }
            return
        }
        switch responseProvider(request.request) {
        case .failure(let error):
            sendFrames([error], on: connection) {
                connection.cancel()
            }
        case .success(let prepared):
            var frames: [Encodable] = [prepared.summary]
            frames.append(contentsOf: prepared.chunks)
            sendFrames(frames, on: connection) {
                ClientDiagnostics.shared.completeResponse(prepared)
                connection.cancel()
            }
        }
    }

    private func respondToScreenshotRequest(_ request: SignedClientScreenshotRequest, on connection: NWConnection) {
        guard let record = storedPairingRecordProvider?(),
              ClientDiagnostics.shared.validateFallbackRequest(request, record: record),
              let responseProvider = screenshotResponseProvider else {
            sendFrames([
                ClientScreenshotError(requestId: request.requestId, reason: "unauthorized")
            ], on: connection) {
                connection.cancel()
            }
            return
        }
        Task { @MainActor [weak self] in
            guard let self else {
                connection.cancel()
                return
            }
            switch await responseProvider(request.request) {
            case .failure(let error):
                self.sendFrames([error], on: connection) {
                    connection.cancel()
                }
            case .success(let prepared):
                var frames: [any Encodable] = [prepared.manifest]
                frames.append(contentsOf: ClientScreenshotCapturer.makeChunks(
                    data: prepared.jpegData,
                    requestId: request.requestId,
                    chunkBytes: Config.screenshotOfferPortChunkBytes
                ))
                self.sendFrames(frames, on: connection) {
                    Task { @MainActor [weak self] in
                        self?.screenshotDeliveryHandler?()
                        connection.cancel()
                    }
                }
            }
        }
    }

    private func sendFrames(
        _ frames: [any Encodable],
        on connection: NWConnection,
        completion: @escaping @Sendable () -> Void
    ) {
        let encoder = JSONEncoder()
        let encodedFrames: [Data]
        do {
            encodedFrames = try frames.map { frame in
                let data = try encode(encodable: frame, encoder: encoder)
                return try OfferPortFrame.encode(data)
            }
        } catch {
            logger.error("offer-port response encoding failed")
            connection.cancel()
            return
        }
        sendFrame(at: 0, from: encodedFrames, on: connection, completion: completion)
    }

    private func sendFrame(
        at index: Int,
        from frames: [Data],
        on connection: NWConnection,
        completion: @escaping @Sendable () -> Void
    ) {
        guard index < frames.count else {
            completion()
            return
        }
        connection.send(content: frames[index], completion: .contentProcessed { [weak self] error in
            guard error == nil else {
                connection.cancel()
                return
            }
            self?.sendFrame(at: index + 1, from: frames, on: connection, completion: completion)
        })
    }

    private func encode(encodable: any Encodable, encoder: JSONEncoder) throws -> Data {
        struct AnyEncodable: Encodable {
            let encodeImpl: (Encoder) throws -> Void
            func encode(to encoder: Encoder) throws { try encodeImpl(encoder) }
        }
        return try encoder.encode(AnyEncodable(encodeImpl: encodable.encode))
    }

    // The iPhone's own tailnet IPv4, shown on the unpaired screen so the user can
    // match this device in the Mac picker. The 100.64/10 CGNAT range is shared:
    // Tailscale uses it, but so does carrier-grade NAT on cellular and some
    // Wi-Fi, so a bare "100." match can return the carrier address instead of the
    // Tailscale one. Tailscale's address lives on a utun interface, so prefer a
    // 100.x address on a utun interface and only fall back to any 100.x otherwise.
    static func ownTailnetIPv4() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0 else { return nil }
        defer { freeifaddrs(ifaddr) }

        var tailscaleAddress: String?
        var fallbackAddress: String?
        var pointer = ifaddr
        while let current = pointer {
            defer { pointer = current.pointee.ifa_next }
            let flags = Int32(current.pointee.ifa_flags)
            guard (flags & (IFF_UP | IFF_RUNNING)) == (IFF_UP | IFF_RUNNING),
                  let addr = current.pointee.ifa_addr,
                  addr.pointee.sa_family == UInt8(AF_INET) else {
                continue
            }
            let interfaceName = String(cString: current.pointee.ifa_name)
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                addr,
                socklen_t(addr.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard result == 0 else { continue }
            let ip = host.withUnsafeBufferPointer { buffer in
                buffer.baseAddress.map { String(cString: $0) } ?? ""
            }
            guard ip.hasPrefix("100.") else { continue }
            if interfaceName.hasPrefix("utun") {
                tailscaleAddress = tailscaleAddress ?? ip
            } else {
                fallbackAddress = fallbackAddress ?? ip
            }
        }
        return tailscaleAddress ?? fallbackAddress
    }
}

// Per-connection receive state. The parser is mutable across reads, so it lives
// in a reference type the receive closure can carry forward. Only ever touched
// on the listener's main queue, so unchecked-Sendable is safe.
private final class OfferConnectionState: @unchecked Sendable {
    let connection: NWConnection
    var parser = OfferPortFrameParser()

    init(connection: NWConnection) {
        self.connection = connection
    }
}
