import CryptoKit
import Foundation
import Testing

struct SessionAuthenticatorTests {
    @Test func allowlistedDeviceCompletesHandshakeAndReturnsActiveSession() throws {
        let fixture = try Fixture()
        let challenge = try fixture.authenticator.processInit(fixture.makeSessionInit(clientNonce: fixture.clientNonce))
        let proof = try fixture.signProof(hostNonce: challenge.hostNonce, clientNonce: fixture.clientNonce)
        let (ready, active) = try fixture.authenticator.processProof(proof)

        #expect(ready.type == "session-ready")
        #expect(active.deviceFingerprint == fixture.deviceFingerprint)
        #expect(active.establishedAt == Int(fixture.clock.timeIntervalSince1970))
    }

    @Test func unknownDeviceReturnsUnknownDeviceRejection() throws {
        let fixture = try Fixture(approveOnSetup: false)
        let initMessage = fixture.makeSessionInit(clientNonce: fixture.clientNonce)

        #expect(throws: SessionRejected(reason: .unknownDevice)) {
            try fixture.authenticator.processInit(initMessage)
        }
    }

    @Test func revokedDeviceTreatedAsUnknownAfterRemovalFromAllowlist() throws {
        let fixture = try Fixture()
        try fixture.pairing.revoke(deviceFingerprint: fixture.deviceFingerprint)
        let initMessage = fixture.makeSessionInit(clientNonce: fixture.clientNonce)

        #expect(throws: SessionRejected(reason: .unknownDevice)) {
            try fixture.authenticator.processInit(initMessage)
        }
    }

    @Test func replayedClientNonceReturnsReplayRejection() throws {
        let fixture = try Fixture()
        _ = try fixture.authenticator.processInit(fixture.makeSessionInit(clientNonce: fixture.clientNonce))

        #expect(throws: SessionRejected(reason: .replay)) {
            try fixture.authenticator.processInit(fixture.makeSessionInit(clientNonce: fixture.clientNonce))
        }
    }

    @Test func garbageClientSignatureReturnsBadSignatureRejection() throws {
        let fixture = try Fixture()
        _ = try fixture.authenticator.processInit(fixture.makeSessionInit(clientNonce: fixture.clientNonce))
        let garbageProof = SessionProof(clientSignature: Data(repeating: 0xab, count: 64))

        #expect(throws: SessionRejected(reason: .badSignature)) {
            try fixture.authenticator.processProof(garbageProof)
        }
    }

    // Regression guard against accidental bearer-token authentication: a
    // valid SessionInit (allowlisted fingerprint + valid SessionToken) with a
    // clientSignature signed by a DIFFERENT key must be rejected. If this
    // ever passes, an attacker with disk access to the token can establish a
    // session without possession of the Secure Enclave key.
    @Test func validTokenWithWrongKeySignatureIsRejected() throws {
        let fixture = try Fixture()
        let challenge = try fixture.authenticator.processInit(fixture.makeSessionInit(clientNonce: fixture.clientNonce))

        let imposterKey = P256.Signing.PrivateKey()
        let signingInput = SessionSigning.canonicalInput(
            clientNonce: fixture.clientNonce,
            hostNonce: challenge.hostNonce,
            hostFingerprint: fixture.hostKey.publicKey.agentDeskFingerprint,
            deviceFingerprint: fixture.deviceFingerprint
        )
        let imposterSignature = try imposterKey.signature(for: signingInput)
        let proof = SessionProof(clientSignature: imposterSignature.rawRepresentation)

        #expect(throws: SessionRejected(reason: .badSignature)) {
            try fixture.authenticator.processProof(proof)
        }
    }
}

private final class Fixture {
    let tempDirectory: URL
    let allowlistURL: URL
    let hostKey: P256.Signing.PrivateKey
    let deviceKey: P256.Signing.PrivateKey
    let deviceFingerprint: DeviceFingerprint
    let sessionToken: SessionToken
    let pairing: Pairing
    let authenticator: SessionAuthenticator
    let clientNonce: Data
    let clock: Date

    init(approveOnSetup: Bool = true) throws {
        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        self.tempDirectory = tempDirectory

        let allowlistURL = tempDirectory.appendingPathComponent("paired-devices.json")
        self.allowlistURL = allowlistURL

        let hostKey = P256.Signing.PrivateKey()
        self.hostKey = hostKey

        let deviceKey = P256.Signing.PrivateKey()
        self.deviceKey = deviceKey

        let deviceFingerprint = DeviceFingerprint(deviceKey.publicKey.agentDeskFingerprint)
        self.deviceFingerprint = deviceFingerprint

        let clock = Date(timeIntervalSince1970: 1_800_000_000)
        self.clock = clock

        let pairing = Pairing(
            keyProvider: InMemoryHostSigningKeyProvider(key: hostKey),
            tailnetDiscovery: StaticTailnetDiscovery(),
            pairedDevices: PairedDeviceStore(url: allowlistURL),
            now: { clock }
        )
        self.pairing = pairing

        if approveOnSetup {
            try pairing.approve(devicePublicKey: deviceKey.publicKey.x963Representation)
        }

        self.sessionToken = try pairing.sessionToken(for: deviceFingerprint)
        self.clientNonce = Data(repeating: 0xa1, count: 32)
        self.authenticator = SessionAuthenticator(
            pairing: pairing,
            now: { clock }
        )
    }

    func makeSessionInit(clientNonce: Data) -> SessionInit {
        SessionInit(
            deviceFingerprint: deviceFingerprint,
            sessionToken: sessionToken,
            clientNonce: clientNonce
        )
    }

    func signProof(hostNonce: Data, clientNonce: Data) throws -> SessionProof {
        let signingInput = SessionSigning.canonicalInput(
            clientNonce: clientNonce,
            hostNonce: hostNonce,
            hostFingerprint: hostKey.publicKey.agentDeskFingerprint,
            deviceFingerprint: deviceFingerprint
        )
        let signature = try deviceKey.signature(for: signingInput)
        return SessionProof(clientSignature: signature.rawRepresentation)
    }
}

private struct InMemoryHostSigningKeyProvider: HostSigningKeyProviding {
    let key: P256.Signing.PrivateKey

    func loadOrCreate() throws -> HostSigningKey {
        .plain(key)
    }
}

private struct StaticTailnetDiscovery: TailnetDiscovering {
    func currentIdentity() throws -> TailnetIdentity {
        TailnetIdentity(fqdn: "mac.tailnet.ts.net", ipv4: "100.64.0.10")
    }
}
