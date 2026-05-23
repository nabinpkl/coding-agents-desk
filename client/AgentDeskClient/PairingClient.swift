import CryptoKit
import Foundation

enum PairingClientState: Equatable {
    case unpaired
    case scanning
    case pairing(PairingPayload)
    case awaitingApproval(PairingPayload)
    case approved(SessionToken)
    case pairedDisconnected
    case sessionConnecting
    case connected(ActiveSession)
    case revoked
    case rejected(String)
}

enum PairingClientError: Error {
    case invalidState
    case signatureMismatch
    case malformedURL
    case websocketRejected(String)
}

struct PairingHandshakeRequest: Codable {
    let type: String
    let devicePublicKey: Data
    let oneTimeNonce: Data
}

struct PairingHandshakeResponse: Codable {
    let type: String
    let token: SessionToken?
    let error: String?
}

protocol DNSResolving {
    func canResolve(_ host: String) -> Bool
}

struct SystemDNSResolver: DNSResolving {
    func canResolve(_ host: String) -> Bool {
        var hints = addrinfo(
            ai_flags: 0,
            ai_family: AF_UNSPEC,
            ai_socktype: SOCK_STREAM,
            ai_protocol: IPPROTO_TCP,
            ai_addrlen: 0,
            ai_canonname: nil,
            ai_addr: nil,
            ai_next: nil
        )
        var result: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(host, nil, &hints, &result)
        if let result {
            freeaddrinfo(result)
        }
        return status == 0
    }
}

@MainActor
final class PairingClient {
    private(set) var state: PairingClientState = .unpaired
    private let tokenStore: SessionTokenStoring
    let deviceKeyProvider: DeviceSigningKeyProviding
    private let resolver: DNSResolving
    private let urlSession: URLSession

    init(
        tokenStore: SessionTokenStoring = KeychainSessionTokenStore(),
        deviceKeyProvider: DeviceSigningKeyProviding = SecureEnclaveDeviceSigningKeyStore(),
        resolver: DNSResolving = SystemDNSResolver(),
        urlSession: URLSession = PairingClient.makeDefaultSession()
    ) {
        self.tokenStore = tokenStore
        self.deviceKeyProvider = deviceKeyProvider
        self.resolver = resolver
        self.urlSession = urlSession
    }

    var storedPairingMaterial: StoredPairingRecord? {
        try? tokenStore.load()
    }

    private static func makeDefaultSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 90
        return URLSession(configuration: configuration)
    }

    func loadStoredPairingMaterial() {
        if (try? tokenStore.load()) != nil {
            state = .pairedDisconnected
        }
    }

    func startScanning() throws {
        guard state == .unpaired || isRejected else {
            throw PairingClientError.invalidState
        }
        state = .scanning
    }

    func acceptScannedCode(_ code: String) throws -> PairingPayload {
        guard state == .scanning else {
            throw PairingClientError.invalidState
        }
        guard let url = URL(string: code) else {
            state = .rejected("malformed-url")
            throw PairingClientError.malformedURL
        }
        let payload = try PairingPayload.decode(fromPairingURL: url)
        state = .pairing(payload)
        return payload
    }

    func receiveApprovedToken(_ token: SessionToken, hostPublicKey: Data) throws {
        switch state {
        case .pairing, .awaitingApproval:
            break
        default:
            throw PairingClientError.invalidState
        }
        guard Self.verify(token: token, hostPublicKey: hostPublicKey) else {
            state = .rejected("signature-mismatch")
            throw PairingClientError.signatureMismatch
        }
        state = .approved(token)
    }

    func persistApprovedToken(payload: PairingPayload) throws {
        guard case .approved(let token) = state else {
            throw PairingClientError.invalidState
        }
        try tokenStore.store(StoredPairingRecord(
            token: token,
            hostPublicKey: payload.hostPublicKey,
            tailnetFQDN: payload.tailnetFQDN,
            tailnetIPv4: payload.tailnetIPv4
        ))
        state = .pairedDisconnected
    }

    func reject(_ reason: String) {
        state = .rejected(reason)
    }

    func clearStoredCredentials() {
        try? tokenStore.clear()
        (activeSignaling as? WebSocketSignalingChannel)?.close()
        activeSignaling = nil
        state = .unpaired
    }

    private(set) var activeSignaling: SignalingChannel?

    func attemptSession(
        dialer: SessionDialer = SessionDialer(),
        port: UInt16 = Config.signalingPort
    ) async throws -> SessionConnection {
        guard let record = storedPairingMaterial else {
            throw PairingClientError.invalidState
        }
        switch state {
        case .pairedDisconnected, .revoked:
            break
        default:
            throw PairingClientError.invalidState
        }
        state = .sessionConnecting

        let host = resolvedHost(fqdn: record.tailnetFQDN, ipv4: record.tailnetIPv4)
        guard let url = URL(string: "wss://\(host):\(port)/session") else {
            state = .pairedDisconnected
            throw PairingClientError.malformedURL
        }
        do {
            let connection = try await dialer.dial(
                url: url,
                deviceFingerprint: DeviceFingerprint(try deviceKeyProvider.publicKey.agentDeskFingerprint),
                sessionToken: record.token,
                hostPublicKey: record.hostPublicKey,
                deviceKey: deviceKeyProvider,
                urlSession: urlSession
            )
            activeSignaling = connection.signaling
            state = .connected(connection.active)
            return connection
        } catch let rejection as SessionRejected {
            applyRejection(rejection)
            throw rejection
        } catch {
            state = .pairedDisconnected
            throw error
        }
    }

    private func applyRejection(_ rejection: SessionRejected) {
        switch rejection.reason {
        case .revoked, .unknownDevice, .badSignature:
            try? tokenStore.clear()
            state = .revoked
        case .replay, .malformed:
            state = .pairedDisconnected
        }
    }

    func performHandshake(for payload: PairingPayload) async throws {
        let host = resolvedHost(for: payload)
        guard let url = URL(string: "wss://\(host):\(Config.signalingPort)/pair") else {
            throw PairingClientError.malformedURL
        }
        let task = urlSession.webSocketTask(with: url)
        task.resume()
        let request = PairingHandshakeRequest(
            type: "pair",
            devicePublicKey: try deviceKeyProvider.publicKey.x963Representation,
            oneTimeNonce: payload.oneTimeNonce
        )
        let data = try JSONEncoder().encode(request)
        guard let text = String(data: data, encoding: .utf8) else {
            throw PairingClientError.malformedURL
        }
        try await task.send(.string(text))
        state = .awaitingApproval(payload)
        let message = try await task.receive()
        task.cancel(with: .normalClosure, reason: nil)

        let responseData: Data
        switch message {
        case .data(let data):
            responseData = data
        case .string(let string):
            responseData = Data(string.utf8)
        @unknown default:
            throw PairingClientError.websocketRejected("unknown-response")
        }

        let response = try JSONDecoder().decode(PairingHandshakeResponse.self, from: responseData)
        guard response.type == "approved", let token = response.token else {
            state = .rejected(response.error ?? "rejected")
            throw PairingClientError.websocketRejected(response.error ?? "rejected")
        }
        try receiveApprovedToken(token, hostPublicKey: payload.hostPublicKey)
        try persistApprovedToken(payload: payload)
    }

    func resolvedHost(for payload: PairingPayload) -> String {
        resolvedHost(fqdn: payload.tailnetFQDN, ipv4: payload.tailnetIPv4)
    }

    func resolvedHost(fqdn rawFQDN: String, ipv4: String) -> String {
        let fqdn = rawFQDN.hasSuffix(".") ? String(rawFQDN.dropLast()) : rawFQDN
        if !fqdn.isEmpty, resolver.canResolve(fqdn) {
            return fqdn
        }
        return ipv4
    }

    static func verify(token: SessionToken, hostPublicKey: Data) -> Bool {
        do {
            let publicKey = try P256.Signing.PublicKey(x963Representation: hostPublicKey)
            guard token.hostFingerprint == publicKey.agentDeskFingerprint else {
                return false
            }
            let signature = try P256.Signing.ECDSASignature(rawRepresentation: token.signature)
            return publicKey.isValidSignature(signature, for: signingData(
                hostFingerprint: token.hostFingerprint,
                deviceFingerprint: token.deviceFingerprint,
                issuedAt: token.issuedAt
            ))
        } catch {
            return false
        }
    }

    static func signingData(hostFingerprint: String, deviceFingerprint: DeviceFingerprint, issuedAt: Int) -> Data {
        var data = Data()
        data.append(Data(hostFingerprint.utf8))
        data.append(Data(deviceFingerprint.rawValue.utf8))
        var issuedAtBigEndian = Int64(issuedAt).bigEndian
        withUnsafeBytes(of: &issuedAtBigEndian) { data.append(contentsOf: $0) }
        return data
    }

    private var isRejected: Bool {
        if case .rejected = state {
            return true
        }
        return false
    }
}

extension P256.Signing.PublicKey {
    var agentDeskFingerprint: String {
        SHA256.hash(data: derRepresentation)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
