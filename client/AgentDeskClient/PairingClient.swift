import CryptoKit
import Foundation
import UIKit
import AgentDeskWire

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
    // ADR-0019: this device's self-reported name, so the host can label the pair
    // with what the phone calls itself instead of the tailnet "localhost".
    let deviceName: String?

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case devicePublicKey
        case oneTimeNonce
        case deviceName
    }
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
        // ADR-0019: production dials the host over the tailnet. When MagicDNS
        // resolves, we dial the FQDN and default (strict) TLS validates the
        // Let's Encrypt cert. When it does not, we fall back to the tailnet IPv4
        // literal, whose connection the FQDN-only cert cannot pass a hostname
        // check for. TailnetServerTrustDelegate accepts that case for CGNAT
        // literals only, still validating the cert chain and leaning on the L3
        // WireGuard authentication of the peer plus the ADR-0003 app-layer P-256
        // mutual challenge as the real host authentication.
        return URLSession(
            configuration: configuration,
            delegate: TailnetServerTrustDelegate(),
            delegateQueue: nil
        )
        #endif
    }

    func loadStoredPairingMaterial() {
        if (try? tokenStore.load()) != nil {
            state = .pairedDisconnected
            ClientDiagnostics.shared.record(type: "storedPairingLoaded", fields: [:], level: .info)
        }
    }

    func startScanning() throws {
        guard state == .unpaired || isRejected else {
            throw PairingClientError.invalidState
        }
        state = .scanning
        ClientDiagnostics.shared.record(type: "pairingScanStarted", fields: [:], level: .info)
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
        ClientDiagnostics.shared.record(
            type: "pairingURLAccepted",
            fields: ["hostFingerprint": payload.hostFingerprint],
            level: .info
        )
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
        ClientDiagnostics.shared.record(
            type: "pairingApproved",
            fields: ["hostFingerprint": token.hostFingerprint],
            level: .info
        )
    }

    func persistApprovedToken(payload: PairingPayload) throws {
        guard case .approved(let token) = state else {
            throw PairingClientError.invalidState
        }
        try tokenStore.store(StoredPairingRecord(
            token: token,
            hostPublicKey: payload.hostPublicKey,
            tailnetFQDN: payload.tailnetFQDN,
            tailnetIPv4: payload.tailnetIPv4,
            signalingPort: payload.signalingPort
        ))
        state = .pairedDisconnected
        ClientDiagnostics.shared.record(type: "pairingPersisted", fields: [:], level: .info)
    }

    func reject(_ reason: String) {
        state = .rejected(reason)
        ClientDiagnostics.shared.record(type: "pairingRejected", fields: ["reason": reason], level: .error)
    }

    func clearStoredCredentials() {
        try? tokenStore.clear()
        inputReconnectTask?.cancel()
        inputReconnectTask = nil
        activeInputChannel?.close()
        activeInputChannel = nil
        activeSessionTransport?.close()
        activeSessionTransport = nil
        activeDomMirror?.stop()
        activeDomMirror = nil
        activeResumeMaterial = nil
        pendingResume = nil
        resetActiveMediaSession()
        state = .unpaired
        ClientDiagnostics.shared.record(type: "storedCredentialsCleared", fields: [:], level: .default)
    }

    private(set) var activeSessionTransport: QuicSessionClientTransport?
    // ADR-0038 DOM mirror: the active .dom lane reader, if this session opened one. The VC starts it
    // and wires it to the replay surface on connect; cleared/stopped on disconnect.
    private(set) var activeDomMirror: DomMirrorClient?
    // ADR-0030: dedicated input lane. PairingViewController.sendInput
    // routes through this instead of the media datagram lane.
    private(set) var activeInputChannel: InputChannel?
    private(set) var activeHost: String?
    // 0 until a session is dialed; then it holds the host's advertised port.
    private(set) var activePort: UInt16 = 0
    private var activeResumeMaterial: SessionResumeMaterial?
    private var pendingResume: (active: ActiveSession, resume: SessionResumeMaterial)?
    private var inputReconnectTask: Task<Void, Never>?

    /// Called by PairingViewController when the owned media channel reports
    /// .failed (or 5s of .disconnected). Tears down the signaling channel
    /// and transitions to .pairedDisconnected so the foreground auto-dial
    /// path can retry on next willEnterForeground.
    func handleMediaSessionFailed(rejection: SessionRejected? = nil) {
        inputReconnectTask?.cancel()
        inputReconnectTask = nil
        activeInputChannel?.close()
        activeInputChannel = nil
        activeSessionTransport?.close()
        activeSessionTransport = nil
        activeDomMirror?.stop()
        activeDomMirror = nil
        if case .connected(let active) = state,
           let resume = activeResumeMaterial {
            pendingResume = (active, resume)
        }
        activeResumeMaterial = nil
        resetActiveMediaSession()
        if let rejection {
            ClientDiagnostics.shared.record(
                type: "mediaSessionFailed",
                fields: ["reason": String(describing: rejection.reason)],
                level: .error
            )
            applyRejection(rejection)
            return
        }
        if case .connected = state {
            state = .pairedDisconnected
        }
        ClientDiagnostics.shared.record(type: "mediaSessionFailed", fields: [:], level: .error)
    }

    func attemptSession(
        dialer: SessionDialer = SessionDialer()
    ) async throws -> SessionConnection {
        guard let record = storedPairingMaterial else {
            throw PairingClientError.invalidState
        }
        // Dial the host's advertised signaling port, persisted at pairing time.
        let port = record.signalingPort
        switch state {
        case .pairedDisconnected, .revoked:
            break
        default:
            throw PairingClientError.invalidState
        }
        state = .sessionConnecting

        let host = resolvedHost(fqdn: record.tailnetFQDN, ipv4: record.tailnetIPv4)
        ClientDiagnostics.shared.record(type: "sessionAttemptStarted", fields: ["host": host], level: .info)
        do {
            try Task.checkCancellation()
            let fingerprint = DeviceFingerprint(try deviceKeyProvider.publicKey.agentDeskFingerprint)
            let connection: SessionHandshakeOutcome
            if let resume = pendingResume,
               resume.resume.expiresAt >= Int(Date().timeIntervalSince1970) {
                connection = try await dialer.resume(
                    host: host,
                    port: port,
                    deviceFingerprint: fingerprint,
                    active: resume.active,
                    resume: resume.resume,
                    hostPublicKey: record.hostPublicKey
                )
            } else {
                pendingResume = nil
                connection = try await dialer.dial(
                    host: host,
                    port: port,
                    deviceFingerprint: fingerprint,
                    sessionToken: record.token,
                    hostPublicKey: record.hostPublicKey,
                    deviceKey: deviceKeyProvider
                )
            }
            do {
                try Task.checkCancellation()
            } catch {
                connection.transport.close()
                throw error
            }
            let session = SessionConnection(
                active: connection.active,
                transport: connection.transport,
                inputChannel: connection.transport,
                mediaTransport: connection.transport,
                resume: connection.resume,
                host: host,
                port: port,
                domMirror: connection.domMirror
            )
            activeSessionTransport = session.transport
            activeDomMirror = session.domMirror
            activeInputChannel = session.inputChannel
            activeHost = session.host
            activePort = session.port
            activeResumeMaterial = session.resume
            pendingResume = nil
            startInputReconnectMonitor(active: session.active, channel: session.inputChannel)
            state = .connected(session.active)
            ClientDiagnostics.shared.record(
                type: "sessionConnected",
                fields: ["host": host, "sessionId": session.active.sessionId],
                level: .default
            )
            return session
        } catch let rejection as SessionRejected {
            resetActiveMediaSession()
            activeResumeMaterial = nil
            pendingResume = nil
            applyRejection(rejection)
            ClientDiagnostics.shared.record(
                type: "sessionRejected",
                fields: ["reason": String(describing: rejection.reason)],
                level: .error
            )
            throw rejection
        } catch is CancellationError {
            resetActiveMediaSession()
            state = .pairedDisconnected
            ClientDiagnostics.shared.record(type: "sessionAttemptCancelled", fields: [:], level: .info)
            throw CancellationError()
        } catch {
            resetActiveMediaSession()
            state = .pairedDisconnected
            ClientDiagnostics.shared.record(
                type: "sessionAttemptFailed",
                fields: ["error": String(describing: error)],
                level: .error
            )
            throw error
        }
    }

    func applyRejection(_ rejection: SessionRejected) {
        switch rejection.reason {
        case .revoked, .unknownDevice, .badSignature, .unauthorized:
            try? tokenStore.clear()
            state = .revoked
        case .replay, .malformed, .expiredResume:
            state = .pairedDisconnected
        case .incompatibleProtocol:
            // Not recoverable by retrying; keep the token but surface that an app
            // update is needed. ADR-0020.
            state = .rejected("update required (incompatible version)")
        }
        ClientDiagnostics.shared.record(
            type: "sessionRejectionApplied",
            fields: ["reason": String(describing: rejection.reason)],
            level: .error
        )
    }

    private func startInputReconnectMonitor(
        active: ActiveSession,
        channel: InputChannel
    ) {
        inputReconnectTask?.cancel()
        inputReconnectTask = Task { [weak self, channel] in
            for await _ in channel.closed {
                await self?.handleInputChannelClosed(active: active, closedChannel: channel)
                break
            }
        }
    }

    private func handleInputChannelClosed(
        active: ActiveSession,
        closedChannel: InputChannel
    ) async {
        guard activeInputChannel === closedChannel,
              case .connected(let current) = state,
              current == active
        else {
            return
        }
        activeSessionTransport?.close()
        activeSessionTransport = nil
        activeDomMirror?.stop()
        activeDomMirror = nil
        activeInputChannel = nil
        if let resume = activeResumeMaterial {
            pendingResume = (active, resume)
        }
        activeResumeMaterial = nil
        inputReconnectTask = nil
        resetActiveMediaSession()
        state = .pairedDisconnected
        ClientDiagnostics.shared.record(
            type: "inputChannelClosed",
            fields: ["sessionId": active.sessionId],
            level: .error
        )
    }

    private func resetActiveMediaSession() {
        activeHost = nil
        activePort = 0
    }

    func performHandshake(for payload: PairingPayload) async throws {
        let host = resolvedHost(for: payload)
        let request = PairingHandshakeRequest(
            type: "pair",
            devicePublicKey: try deviceKeyProvider.publicKey.x963Representation,
            oneTimeNonce: payload.oneTimeNonce,
            deviceName: deviceDisplayName()
        )
        state = .awaitingApproval(payload)
        ClientDiagnostics.shared.record(type: "pairingHandshakeStarted", fields: [:], level: .info)
        let response = try await SessionDialer().performPairingHandshake(
            host: host,
            port: payload.signalingPort,
            request: request
        )
        guard response.type == "approved", let token = response.token else {
            state = .rejected(response.error ?? "rejected")
            throw PairingClientError.websocketRejected(response.error ?? "rejected")
        }
        try receiveApprovedToken(token, hostPublicKey: payload.hostPublicKey)
        try persistApprovedToken(payload: payload)
    }

    // This device's name for the host to display. iOS 16+ returns a generic
    // "iPhone" for UIDevice.name without the user-assigned-device-name
    // entitlement, so when the name carries no information fall back to the
    // hardware model identifier (e.g. "iPhone16,1"), and always append a short,
    // stable per-device id (the device fingerprint prefix) so two same-model
    // phones are distinguishable.
    func deviceDisplayName() -> String {
        let assigned = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = (assigned.isEmpty || assigned == "iPhone") ? Self.modelIdentifier() : assigned
        if let fingerprint = try? deviceKeyProvider.publicKey.agentDeskFingerprint {
            return "\(base) [\(fingerprint.prefix(6))]"
        }
        return base
    }

    // The hardware model identifier from uname, e.g. "iPhone16,1". Unmapped to a
    // marketing name on purpose: a model-name table rots with every new device,
    // and the identifier plus the per-device id already differentiates phones.
    private static func modelIdentifier() -> String {
        var info = utsname()
        uname(&info)
        let identifier = withUnsafeBytes(of: &info.machine) { buffer -> String in
            String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
        }
        return identifier.isEmpty ? "iPhone" : identifier
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
#endif

// ADR-0019: scoped TLS trust for production. Default (strict) validation applies
// to every host except a tailnet CGNAT IPv4 literal (100.64.0.0/10), which we
// reach only when MagicDNS could not resolve the host FQDN. For that case the
// host's Let's Encrypt cert is issued for the FQDN, so the hostname check cannot
// pass; we validate the cert CHAIN (still rejecting a self-signed or untrusted
// cert) but skip the hostname match. Safe because the tailnet authenticates the
// peer at L3 (WireGuard, the IP cannot be spoofed to another machine) and the
// ADR-0003 challenge-response cryptographically authenticates the host before
// any session is granted; TLS here is transport encryption over the already
// encrypted tailnet.
final class TailnetServerTrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              Self.isTailnetCGNAT(challenge.protectionSpace.host) else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // Hostname-less SSL policy: enforce the chain to a trusted anchor, skip
        // the hostname match for the IP literal.
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, nil))
        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    // True for an IPv4 literal in Tailscale's CGNAT range 100.64.0.0/10.
    static func isTailnetCGNAT(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        return octets[0] == 100 && (64...127).contains(octets[1])
    }
}

extension P256.Signing.PublicKey {
    var agentDeskFingerprint: String {
        SHA256.hash(data: derRepresentation)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
