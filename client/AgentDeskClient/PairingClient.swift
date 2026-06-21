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

    var mediaURLSession: URLSession {
        urlSession
    }

    private static func makeDefaultSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 90
        #if DEBUG
        // Dev-only: bypass TLS hostname/cert validation. The host's
        // cryptographic identity is still authenticated at the
        // application layer via the mutual challenge-response in
        // ADR-0003 (hostSignature over fresh nonces). Without this,
        // running the client in the iOS Simulator against a host
        // whose Tailnet IP can't loop back to itself forces us to
        // rewrite the URL to 127.0.0.1, which then fails TLS
        // hostname validation against the cert issued for the
        // Tailnet FQDN.
        return URLSession(
            configuration: configuration,
            delegate: PermissiveURLSessionDelegate(),
            delegateQueue: nil
        )
        #else
        // Production: trust the server cert when dialing a Tailscale CGNAT
        // literal, since the locator-code fetch and the ipv4 fallback reach the
        // host by IP where the FQDN cert fails hostname validation. FQDN dials
        // still get default validation. See CGNATServerTrustDelegate.
        return URLSession(
            configuration: configuration,
            delegate: CGNATServerTrustDelegate(),
            delegateQueue: nil
        )
        #endif
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

    // ADR-0018 code pairing: decode a typed locator code into its tailnet IPv4
    // and fetch token. State stays .scanning; fetchPayload advances it.
    func acceptLocatorCode(_ raw: String) throws -> LocatorCode {
        guard state == .scanning else {
            throw PairingClientError.invalidState
        }
        do {
            return try LocatorCode.decode(raw)
        } catch {
            state = .rejected("malformed-code")
            throw error
        }
    }

    // ADR-0018 code pairing: pull the signed payload from the host over the
    // tailnet using the fetch token, then hand off to the unchanged
    // performHandshake flow. Trust rests on the payload signature + host
    // approval, not on TLS hostname validation of the CGNAT literal.
    func fetchPayload(for code: LocatorCode) async throws -> PairingPayload {
        let host = resolvedHostForLocator(ipv4: code.tailnetIPv4)
        guard let url = URL(string: "wss://\(host):\(Config.signalingPort)/pair") else {
            throw PairingClientError.malformedURL
        }
        let task = urlSession.webSocketTask(with: url)
        task.resume()
        let request = PairingPayloadFetchRequest(fetchToken: code.fetchToken)
        let data = try JSONEncoder().encode(request)
        guard let text = String(data: data, encoding: .utf8) else {
            throw PairingClientError.malformedURL
        }
        try await task.send(.string(text))
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

        let response = try JSONDecoder().decode(PairingPayloadFetchResponse.self, from: responseData)
        guard response.type == "ok", let payload = response.payload else {
            state = .rejected(response.error ?? "fetch-rejected")
            throw PairingClientError.websocketRejected(response.error ?? "fetch-rejected")
        }
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
        activeSignaling?.close()
        activeSignaling = nil
        inputReconnectTask?.cancel()
        inputReconnectTask = nil
        activeInputChannel?.close()
        activeInputChannel = nil
        resetActiveMediaSession()
        state = .unpaired
    }

    private(set) var activeSignaling: SignalingChannel?
    // ADR-0005: dedicated input transport. PairingViewController.sendInput
    // routes through this instead of the deleted MediaTransport.send.
    private(set) var activeInputChannel: InputChannel?
    private(set) var activeMediaCapability: MediaCapabilityGrant?
    private(set) var activeHost: String?
    private(set) var activePort: UInt16 = Config.signalingPort
    private var inputReconnectTask: Task<Void, Never>?

    /// Called by PairingViewController when the owned media channel reports
    /// .failed (or 5s of .disconnected). Tears down the signaling channel
    /// and transitions to .pairedDisconnected so the foreground auto-dial
    /// path can retry on next willEnterForeground.
    func handleMediaSessionFailed(rejection: SessionRejected? = nil) {
        activeSignaling?.close()
        activeSignaling = nil
        inputReconnectTask?.cancel()
        inputReconnectTask = nil
        activeInputChannel?.close()
        activeInputChannel = nil
        resetActiveMediaSession()
        if let rejection {
            applyRejection(rejection)
            return
        }
        if case .connected = state {
            state = .pairedDisconnected
        }
    }

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
            // ADR-0005: open the dedicated input channel alongside the
            // session signaling channel. Same host, same port, different
            // URL path. Failure to open the input channel fails the
            // whole session attempt -- a session with no input is not
            // useful and we'd rather retry the dial than half-connect.
            let inputChannel: InputChannel
            do {
                inputChannel = try await InputChannelOpener.open(
                    host: host,
                    port: port,
                    deviceFingerprint: connection.active.deviceFingerprint,
                    sessionId: connection.active.sessionId,
                    inputCapability: connection.inputCapability.inputCapability,
                    urlSession: urlSession
                )
            } catch {
                connection.signaling.close()
                throw error
            }
            let session = SessionConnection(
                active: connection.active,
                signaling: connection.signaling,
                inputChannel: inputChannel,
                mediaCapability: connection.mediaCapability,
                host: host,
                port: port
            )
            activeSignaling = session.signaling
            activeInputChannel = session.inputChannel
            activeMediaCapability = session.mediaCapability
            activeHost = session.host
            activePort = session.port
            startInputReconnectMonitor(
                host: host,
                port: port,
                active: session.active,
                signaling: session.signaling,
                channel: session.inputChannel
            )
            state = .connected(session.active)
            return session
        } catch let rejection as SessionRejected {
            resetActiveMediaSession()
            applyRejection(rejection)
            throw rejection
        } catch {
            resetActiveMediaSession()
            state = .pairedDisconnected
            throw error
        }
    }

    func applyRejection(_ rejection: SessionRejected) {
        switch rejection.reason {
        case .revoked, .unknownDevice, .badSignature, .unauthorized:
            try? tokenStore.clear()
            state = .revoked
        case .replay, .malformed, .expiredInputCapability, .staleInputCapability,
             .expiredMediaCapability, .staleMediaCapability:
            state = .pairedDisconnected
        }
    }

    private func startInputReconnectMonitor(
        host: String,
        port: UInt16,
        active: ActiveSession,
        signaling: SignalingChannel,
        channel: InputChannel
    ) {
        inputReconnectTask?.cancel()
        inputReconnectTask = Task { [weak self, channel, signaling] in
            for await _ in channel.closed {
                await self?.handleInputChannelClosed(
                    host: host,
                    port: port,
                    active: active,
                    signaling: signaling,
                    closedChannel: channel
                )
                break
            }
        }
    }

    private func handleInputChannelClosed(
        host: String,
        port: UInt16,
        active: ActiveSession,
        signaling: SignalingChannel,
        closedChannel: InputChannel
    ) async {
        guard activeInputChannel === closedChannel,
              case .connected(let current) = state,
              current == active,
              let refresher = signaling as? InputCapabilityRefreshing
        else {
            return
        }
        do {
            let grant = try await refresher.refreshInputCapability(
                deviceFingerprint: active.deviceFingerprint,
                sessionId: active.sessionId
            )
            let replacement = try await InputChannelOpener.open(
                host: host,
                port: port,
                deviceFingerprint: active.deviceFingerprint,
                sessionId: active.sessionId,
                inputCapability: grant.inputCapability,
                urlSession: urlSession
            )
            activeInputChannel = replacement
            startInputReconnectMonitor(
                host: host,
                port: port,
                active: active,
                signaling: signaling,
                channel: replacement
            )
        } catch let rejection as SessionRejected {
            activeSignaling?.close()
            activeSignaling = nil
            activeInputChannel = nil
            inputReconnectTask = nil
            resetActiveMediaSession()
            applyRejection(rejection)
        } catch {
            activeSignaling?.close()
            activeSignaling = nil
            activeInputChannel = nil
            inputReconnectTask = nil
            resetActiveMediaSession()
            state = .pairedDisconnected
        }
    }

    private func resetActiveMediaSession() {
        activeMediaCapability = nil
        activeHost = nil
        activePort = Config.signalingPort
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
        #if targetEnvironment(simulator)
        // Simulator dev path: the simulator shares the Mac's network
        // stack but cannot reach the host's Tailscale magic-DNS name or
        // the Tailnet IPv4 (no Tailscale running inside the simulator
        // sandbox), so both fqdn and ipv4 fail with NSURLErrorTimedOut.
        // pair-sim sets AGENTDESK_DEV_HOST_OVERRIDE=localhost so we dial
        // the host's listener on the loopback interface instead. The
        // host's NWListener binds to all interfaces, and the DEBUG
        // PermissiveURLSessionDelegate already bypasses TLS hostname
        // validation so the Tailnet-FQDN cert mismatch on localhost is
        // tolerated. Guard rail: this entire branch compiles out of
        // device builds via targetEnvironment.
        //
        // Env first (so a fresh override beats a stale persisted one),
        // then UserDefaults (SceneDelegate persists on launch so the
        // override survives Maestro relaunches that do not forward env).
        if let override = ProcessInfo.processInfo.environment["AGENTDESK_DEV_HOST_OVERRIDE"],
           !override.isEmpty {
            return override
        }
        if let stored = UserDefaults.standard.string(forKey: "agentDesk.dev.hostOverride"),
           !stored.isEmpty {
            return stored
        }
        #endif
        let fqdn = rawFQDN.hasSuffix(".") ? String(rawFQDN.dropLast()) : rawFQDN
        if !fqdn.isEmpty, resolver.canResolve(fqdn) {
            return fqdn
        }
        return ipv4
    }

    // ADR-0018: a locator code carries only the tailnet IPv4 (no FQDN), so dial
    // the literal directly. The simulator has no Tailscale, so honor the dev
    // host override there, matching resolvedHost(fqdn:ipv4:).
    func resolvedHostForLocator(ipv4: String) -> String {
        #if targetEnvironment(simulator)
        if let override = ProcessInfo.processInfo.environment["AGENTDESK_DEV_HOST_OVERRIDE"],
           !override.isEmpty {
            return override
        }
        if let stored = UserDefaults.standard.string(forKey: "agentDesk.dev.hostOverride"),
           !stored.isEmpty {
            return stored
        }
        #endif
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

#if DEBUG
// Dev-only delegate that accepts any server trust. See makeDefaultSession
// above; application-layer signing per ADR-0003 is the authentication of
// record.
final class PermissiveURLSessionDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
#else
// Production: trust the server cert only when the connection host is a
// Tailscale CGNAT literal (100.64.0.0/10). The locator-code fetch and the
// ipv4 fallback dial the host by IP, where the FQDN-issued cert fails
// hostname validation; Tailscale authenticates the peer at L3 and the signed
// payload plus host approval are the trust anchors (ADR-0003, ADR-0018).
// FQDN connections fall through to default validation.
final class CGNATServerTrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust,
           Self.isCGNAT(challenge.protectionSpace.host) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    static func isCGNAT(_ host: String) -> Bool {
        let parts = host.split(separator: ".")
        guard parts.count == 4 else { return false }
        var address: UInt32 = 0
        for part in parts {
            guard let octet = UInt8(part) else { return false }
            address = (address << 8) | UInt32(octet)
        }
        return address & 0xFFC0_0000 == 0x6440_0000
    }
}
#endif

extension P256.Signing.PublicKey {
    var agentDeskFingerprint: String {
        SHA256.hash(data: derRepresentation)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
