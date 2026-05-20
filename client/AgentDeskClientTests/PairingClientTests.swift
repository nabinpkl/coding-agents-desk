import CryptoKit
import Foundation
import Testing

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
            expiresAt: 1_800_000_090
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

    @Test func stateMachineConnectsAndRejectsSignatureMismatch() throws {
        let hostKey = P256.Signing.PrivateKey()
        let deviceFingerprint = DeviceFingerprint("device")
        let payload = PairingPayload(
            hostFingerprint: hostKey.publicKey.agentDeskFingerprint,
            hostPublicKey: hostKey.publicKey.x963Representation,
            tailnetFQDN: "mac.tailnet.ts.net",
            tailnetIPv4: "100.64.0.10",
            oneTimeNonce: Data(repeating: 3, count: 32),
            expiresAt: 1_800_000_090
        )
        let token = try signedToken(hostKey: hostKey, deviceFingerprint: deviceFingerprint)
        let store = InMemorySessionTokenStore()
        let client = PairingClient(tokenStore: store, deviceKeyProvider: InMemoryDeviceSigningKeyProvider(), resolver: StaticResolver())

        try client.startScanning()
        #expect(client.state == .scanning)

        let scanned = try client.acceptScannedCode(try payload.pairingURL().absoluteString)
        #expect(scanned == payload)
        #expect(client.state == .connecting(payload))

        try client.receiveApprovedToken(token, hostPublicKey: hostKey.publicKey.x963Representation)
        #expect(client.state == .approved(token))

        try client.persistApprovedToken(hostPublicKey: hostKey.publicKey.x963Representation)
        #expect(client.state == .connected(token))
        #expect(try store.load()?.token == token)

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
