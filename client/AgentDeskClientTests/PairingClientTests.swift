import CryptoKit
import Foundation
import Testing
import AgentDeskWire

@MainActor
struct PairingClientTests {
    @Test func parserAcceptsWellFormedURLAndRejectsMalformedInputs() throws {
        let hostKey = P256.Signing.PrivateKey()
        let payload = PairingPayload(
            hostFingerprint: hostKey.publicKey.agentDeskFingerprint,
            hostPublicKey: hostKey.publicKey.x963Representation,
            tailnetFQDN: "mac.tailnet.ts.net",
            tailnetIPv4: "100.64.0.10",
            oneTimeNonce: Data(repeating: 7, count: 32),
            expiresAt: 1_800_000_090,
            signalingPort: 41_888
        )
        let url = try payload.pairingURL()

        #expect(try PairingPayload.decode(fromPairingURL: url) == payload)
        #expect(throws: Error.self) {
            _ = try PairingPayload.decode(fromPairingURL: URL(string: "https://example.com")!)
        }
        #expect(throws: Error.self) {
            _ = try PairingPayload.decode(fromPairingURL: URL(string: "agentdesk://pair?p=not-base64")!)
        }
    }

    @Test func pairingHandshakeRequestUsesControlDiscriminatorKey() throws {
        let request = PairingHandshakeRequest(
            type: "pair",
            devicePublicKey: Data([1, 2, 3]),
            oneTimeNonce: Data([4, 5, 6]),
            deviceName: "sim"
        )

        let data = try JSONEncoder().encode(request)
        let decoded = try JSONDecoder().decode(PairingHandshakeRequest.self, from: data)
        let json = String(data: data, encoding: .utf8) ?? ""

        #expect(decoded.type == "pair")
        #expect(json.contains("\"t\":\"pair\""))
        #expect(!json.contains("\"type\""))
    }

    @Test func stateMachineConnectsAndRejectsSignatureMismatch() throws {
        let hostKey = P256.Signing.PrivateKey()
        let deviceFingerprint = DeviceFingerprint("device")
        let payload = PairingPayload(
            hostFingerprint: hostKey.publicKey.agentDeskFingerprint,
            hostPublicKey: hostKey.publicKey.x963Representation,
            tailnetFQDN: "mac.tailnet.ts.net",
            tailnetIPv4: "100.64.0.10",
            oneTimeNonce: Data(repeating: 3, count: 32),
            expiresAt: 1_800_000_090,
            signalingPort: 41_888
        )
        let token = try signedToken(hostKey: hostKey, deviceFingerprint: deviceFingerprint)
        let store = InMemorySessionTokenStore()
        let client = PairingClient(tokenStore: store, deviceKeyProvider: InMemoryDeviceSigningKeyProvider(), resolver: StaticResolver())

        try client.startScanning()
        #expect(client.state == .scanning)

        let scanned = try client.acceptScannedCode(try payload.pairingURL().absoluteString)
        #expect(scanned == payload)
        #expect(client.state == .pairing(payload))

        try client.receiveApprovedToken(token, hostPublicKey: hostKey.publicKey.x963Representation)
        #expect(client.state == .approved(token))

        try client.persistApprovedToken(payload: payload)
        #expect(client.state == .pairedDisconnected)
        let loaded = try store.load()
        #expect(loaded?.token == token)
        #expect(loaded?.tailnetFQDN == payload.tailnetFQDN)
        #expect(loaded?.tailnetIPv4 == payload.tailnetIPv4)
        // The host's advertised signaling port must persist so a re-dial after
        // relaunch reaches the same-tier host without assuming a default port.
        #expect(loaded?.signalingPort == payload.signalingPort)

        let rejectingClient = PairingClient(tokenStore: InMemorySessionTokenStore(), deviceKeyProvider: InMemoryDeviceSigningKeyProvider(), resolver: StaticResolver())
        try rejectingClient.startScanning()
        _ = try rejectingClient.acceptScannedCode(try payload.pairingURL().absoluteString)
        let badToken = SessionToken(
            hostFingerprint: token.hostFingerprint,
            deviceFingerprint: token.deviceFingerprint,
            issuedAt: token.issuedAt,
            signature: Data(repeating: 2, count: 64)
        )

        #expect(throws: PairingClientError.self) {
            try rejectingClient.receiveApprovedToken(badToken, hostPublicKey: hostKey.publicKey.x963Representation)
        }
        #expect(rejectingClient.state == .rejected("signature-mismatch"))
    }

    @Test func mediaSessionRevokedFailureClearsStoredCredentials() throws {
        let hostKey = P256.Signing.PrivateKey()
        let token = try signedToken(hostKey: hostKey, deviceFingerprint: DeviceFingerprint("device"))
        let store = InMemorySessionTokenStore()
        try store.store(StoredPairingRecord(
            token: token,
            hostPublicKey: hostKey.publicKey.x963Representation,
            tailnetFQDN: "mac.tailnet.ts.net",
            tailnetIPv4: "100.64.0.10",
            signalingPort: 41_888
        ))
        let client = PairingClient(tokenStore: store, deviceKeyProvider: InMemoryDeviceSigningKeyProvider(), resolver: StaticResolver())

        client.handleMediaSessionFailed(rejection: SessionRejected(reason: .revoked))

        #expect(client.state == .revoked)
        #expect(try store.load() == nil)
    }

    @Test func revokedRefreshRejectionClearsStoredCredentials() throws {
        let hostKey = P256.Signing.PrivateKey()
        let token = try signedToken(hostKey: hostKey, deviceFingerprint: DeviceFingerprint("device"))
        let store = InMemorySessionTokenStore()
        try store.store(StoredPairingRecord(
            token: token,
            hostPublicKey: hostKey.publicKey.x963Representation,
            tailnetFQDN: "mac.tailnet.ts.net",
            tailnetIPv4: "100.64.0.10",
            signalingPort: 41_888
        ))
        let client = PairingClient(tokenStore: store, deviceKeyProvider: InMemoryDeviceSigningKeyProvider(), resolver: StaticResolver())

        client.applyRejection(SessionRejected(reason: .revoked))

        #expect(client.state == .revoked)
        #expect(try store.load() == nil)
    }

    @Test func transientSessionRejectionsStayPairedDisconnected() throws {
        let hostKey = P256.Signing.PrivateKey()
        let token = try signedToken(hostKey: hostKey, deviceFingerprint: DeviceFingerprint("device"))
        for reason in [
            SessionRejectionReason.replay,
            .malformed,
            .expiredResume
        ] {
            let store = InMemorySessionTokenStore()
            try store.store(StoredPairingRecord(
                token: token,
                hostPublicKey: hostKey.publicKey.x963Representation,
                tailnetFQDN: "mac.tailnet.ts.net",
                tailnetIPv4: "100.64.0.10",
                signalingPort: 41_888
            ))
            let client = PairingClient(tokenStore: store, deviceKeyProvider: InMemoryDeviceSigningKeyProvider(), resolver: StaticResolver())

            client.applyRejection(SessionRejected(reason: reason))

            #expect(client.state == .pairedDisconnected)
            #expect(try store.load()?.token == token)
        }
    }

    private func signedToken(hostKey: P256.Signing.PrivateKey, deviceFingerprint: DeviceFingerprint) throws -> SessionToken {
        let issuedAt = 1_800_000_000
        let hostFingerprint = hostKey.publicKey.agentDeskFingerprint
        let signature = try hostKey.signature(for: PairingClient.signingData(
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint,
            issuedAt: issuedAt
        ))
        return SessionToken(
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint,
            issuedAt: issuedAt,
            signature: signature.rawRepresentation
        )
    }
}

private final class InMemorySessionTokenStore: SessionTokenStoring {
    private var record: StoredPairingRecord?

    func load() throws -> StoredPairingRecord? {
        record
    }

    func store(_ record: StoredPairingRecord) throws {
        self.record = record
    }

    func clear() throws {
        record = nil
    }
}

private struct InMemoryDeviceSigningKeyProvider: DeviceSigningKeyProviding {
    private let key = P256.Signing.PrivateKey()

    var publicKey: P256.Signing.PublicKey {
        get throws { key.publicKey }
    }

    func signature(for data: Data) throws -> P256.Signing.ECDSASignature {
        try key.signature(for: data)
    }
}

private struct StaticResolver: DNSResolving {
    func canResolve(_ host: String) -> Bool {
        true
    }
}

// ADR-0019: the Release TLS delegate only relaxes the hostname check for tailnet
// CGNAT IPv4 literals; everything else (FQDNs, public IPs) gets strict default
// validation.
struct TailnetServerTrustDelegateTests {
    @Test func recognizesTailnetCGNATLiterals() {
        #expect(TailnetServerTrustDelegate.isTailnetCGNAT("100.64.0.10"))
        #expect(TailnetServerTrustDelegate.isTailnetCGNAT("100.100.1.1"))
        #expect(TailnetServerTrustDelegate.isTailnetCGNAT("100.127.255.255"))
    }

    @Test func rejectsNonTailnetHosts() {
        #expect(!TailnetServerTrustDelegate.isTailnetCGNAT("mac.tail000000.ts.net"))
        #expect(!TailnetServerTrustDelegate.isTailnetCGNAT("100.63.0.1"))
        #expect(!TailnetServerTrustDelegate.isTailnetCGNAT("100.128.0.1"))
        #expect(!TailnetServerTrustDelegate.isTailnetCGNAT("10.0.0.1"))
        #expect(!TailnetServerTrustDelegate.isTailnetCGNAT("100.64.0"))
        #expect(!TailnetServerTrustDelegate.isTailnetCGNAT("192.168.1.1"))
    }
}
