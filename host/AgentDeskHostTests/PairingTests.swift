import CryptoKit
import Foundation
import Testing

struct PairingTests {
    @Test func mintedPairingPayloadRoundTripsThroughBase64URL() throws {
        let fixture = try PairingFixture()
        let payload = try fixture.pairing.mintPairingPayload()
        let url = try payload.pairingURL()
        let decoded = try PairingPayload.decode(fromPairingURL: url)

        #expect(decoded == payload)
        #expect(url.absoluteString.hasPrefix("agentdesk://pair?p="))
        #expect(payload.oneTimeNonce.count == 32)
    }

    @Test func approveAddsFingerprintToAllowlistFile() throws {
        let fixture = try PairingFixture()
        let deviceKey = P256.Signing.PrivateKey()
        let expectedFingerprint = DeviceFingerprint(deviceKey.publicKey.agentDeskFingerprint)

        try fixture.pairing.approve(devicePublicKey: deviceKey.publicKey.x963Representation)
        let records = try JSONDecoder().decode([PairedDeviceRecord].self, from: Data(contentsOf: fixture.allowlistURL))

        #expect(records.count == 1)
        #expect(records[0].deviceFingerprint == expectedFingerprint)
        #expect(records[0].devicePublicKey == deviceKey.publicKey.x963Representation)
    }

    @Test func validateAcceptsSignedAllowlistedTokenAndRejectsOthers() throws {
        let fixture = try PairingFixture()
        let approvedKey = P256.Signing.PrivateKey()
        let unapprovedKey = P256.Signing.PrivateKey()
        let approved = DeviceFingerprint(approvedKey.publicKey.agentDeskFingerprint)
        let unapproved = DeviceFingerprint(unapprovedKey.publicKey.agentDeskFingerprint)

        try fixture.pairing.approve(devicePublicKey: approvedKey.publicKey.x963Representation)
        let validToken = try fixture.pairing.sessionToken(for: approved)
        let unapprovedToken = try fixture.pairing.sessionToken(for: unapproved)
        let wrongSignatureToken = SessionToken(
            hostFingerprint: validToken.hostFingerprint,
            deviceFingerprint: approved,
            issuedAt: validToken.issuedAt,
            signature: Data(repeating: 1, count: 64)
        )

        #expect(fixture.pairing.validate(token: validToken))
        #expect(!fixture.pairing.validate(token: unapprovedToken))
        #expect(!fixture.pairing.validate(token: wrongSignatureToken))
    }

    @Test func revokeRemovesFingerprintAndInvalidatesToken() throws {
        let fixture = try PairingFixture()
        let deviceKey = P256.Signing.PrivateKey()
        let fingerprint = DeviceFingerprint(deviceKey.publicKey.agentDeskFingerprint)

        try fixture.pairing.approve(devicePublicKey: deviceKey.publicKey.x963Representation)
        let token = try fixture.pairing.sessionToken(for: fingerprint)
        #expect(fixture.pairing.validate(token: token))

        try fixture.pairing.revoke(deviceFingerprint: fingerprint)

        #expect(!fixture.pairing.validate(token: token))
        #expect(try fixture.pairing.approvedDevices().isEmpty)
    }

    @Test func approvalAttemptRejectsUnknownAndExpiredNonces() throws {
        final class MutableClock {
            var date = Date(timeIntervalSince1970: 1_800_000_000)
        }

        let clock = MutableClock()
        let fixture = try PairingFixture(now: { clock.date })
        let payload = try fixture.pairing.mintPairingPayload()
        let deviceKey = P256.Signing.PrivateKey()

        #expect(throws: PairingError.self) {
            try fixture.pairing.approve(
                devicePublicKey: deviceKey.publicKey.x963Representation,
                oneTimeNonce: Data("missing".utf8)
            )
        }

        clock.date = clock.date.addingTimeInterval(91)

        #expect(throws: PairingError.self) {
            try fixture.pairing.approve(
                devicePublicKey: deviceKey.publicKey.x963Representation,
                oneTimeNonce: payload.oneTimeNonce
            )
        }
    }

    // ADR-0019: offer frame round-trips one whole offer.
    @Test func offerFrameRoundTripsAPayload() throws {
        let fixture = try PairingFixture()
        let payload = try fixture.pairing.mintPairingPayload()
        let frame = try PairingOfferFrame.encode(payload)

        var parser = PairingOfferFrameParser()
        let offers = try parser.append(frame)

        #expect(offers == [payload])
    }

    // The parser must reassemble a frame delivered byte-by-byte, the normal
    // case for a streamed TCP connection. Only the final chunk completes it.
    @Test func offerFrameParserReassemblesAcrossChunks() throws {
        let fixture = try PairingFixture()
        let payload = try fixture.pairing.mintPairingPayload()
        let frame = try PairingOfferFrame.encode(payload)

        var parser = PairingOfferFrameParser()
        var collected: [PairingPayload] = []
        for byte in frame {
            collected += try parser.append(Data([byte]))
        }

        #expect(collected == [payload])
    }

    // A zero-length frame is malformed and must be rejected, not yielded.
    @Test func offerFrameParserRejectsZeroLengthFrame() throws {
        var parser = PairingOfferFrameParser()
        #expect(throws: PairingPayloadError.self) {
            _ = try parser.append(Data([0, 0, 0, 0]))
        }
    }
}

private struct PairingFixture {
    let tempDirectory: URL
    let allowlistURL: URL
    let key: P256.Signing.PrivateKey
    let pairing: Pairing

    init(now: @escaping () -> Date = Date.init) throws {
        tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        allowlistURL = tempDirectory.appendingPathComponent("paired-devices.json")
        key = P256.Signing.PrivateKey()
        pairing = Pairing(
            keyProvider: InMemoryHostSigningKeyProvider(key: key),
            tailnetDiscovery: StaticTailnetDiscovery(),
            pairedDevices: PairedDeviceStore(url: allowlistURL),
            now: now
        )
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
