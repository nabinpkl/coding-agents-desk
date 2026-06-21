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
        #expect(client.state == .pairing(payload))

        try client.receiveApprovedToken(token, hostPublicKey: hostKey.publicKey.x963Representation)
        #expect(client.state == .approved(token))

        try client.persistApprovedToken(payload: payload)
        #expect(client.state == .pairedDisconnected)
        let loaded = try store.load()
        #expect(loaded?.token == token)
        #expect(loaded?.tailnetFQDN == payload.tailnetFQDN)
        #expect(loaded?.tailnetIPv4 == payload.tailnetIPv4)

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

    @Test func postReadySessionRejectedSurfacesThroughCapabilityRefresh() async throws {
        let channel = WebSocketSignalingChannel(
            capabilityRequestSender: { _ in },
            closer: {}
        )
        let refresh = Task {
            try await channel.refreshInputCapability(
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123"
            )
        }

        try await Task.sleep(nanoseconds: 10_000_000)
        channel.deliver(SessionRejected(reason: .revoked))

        do {
            _ = try await refresh.value
            Issue.record("capability refresh unexpectedly succeeded")
        } catch let rejection as SessionRejected {
            #expect(rejection.reason == .revoked)
        }
    }

    @Test func mediaCapabilityRefreshSendsRequestAndResumesWithGrant() async throws {
        let requests = MediaRefreshRequests()
        let channel = WebSocketSignalingChannel(
            capabilityRequestSender: { _ in },
            mediaCapabilityRequestSender: { request in
                await requests.append(request)
            },
            closer: {}
        )
        let refresh = Task {
            try await channel.refreshMediaCapability(
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123"
            )
        }

        try await waitUntil {
            await requests.values.count == 1
        }
        #expect(await requests.values == [
            MediaCapabilityRefreshRequest(
                deviceFingerprint: DeviceFingerprint("device-fp"),
                sessionId: "session-123"
            )
        ])
        channel.deliver(MediaCapabilityGrant(
            sessionId: "session-123",
            mediaCapability: "media-capability-fresh",
            mediaCapabilityExpiresAt: 1_800_000_060
        ))

        let grant = try await refresh.value
        #expect(grant.mediaCapability == "media-capability-fresh")
        #expect(grant.mediaCapabilityExpiresAt == 1_800_000_060)
    }

    @Test func mediaSessionRevokedFailureClearsStoredCredentials() throws {
        let hostKey = P256.Signing.PrivateKey()
        let token = try signedToken(hostKey: hostKey, deviceFingerprint: DeviceFingerprint("device"))
        let store = InMemorySessionTokenStore()
        try store.store(StoredPairingRecord(
            token: token,
            hostPublicKey: hostKey.publicKey.x963Representation,
            tailnetFQDN: "mac.tailnet.ts.net",
            tailnetIPv4: "100.64.0.10"
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
            tailnetIPv4: "100.64.0.10"
        ))
        let client = PairingClient(tokenStore: store, deviceKeyProvider: InMemoryDeviceSigningKeyProvider(), resolver: StaticResolver())

        client.applyRejection(SessionRejected(reason: .revoked))

        #expect(client.state == .revoked)
        #expect(try store.load() == nil)
    }

    @Test func staleAndExpiredRefreshRejectionsStayPairedDisconnected() throws {
        let hostKey = P256.Signing.PrivateKey()
        let token = try signedToken(hostKey: hostKey, deviceFingerprint: DeviceFingerprint("device"))
        for reason in [
            SessionRejectionReason.staleInputCapability,
            .expiredInputCapability,
            .staleMediaCapability,
            .expiredMediaCapability
        ] {
            let store = InMemorySessionTokenStore()
            try store.store(StoredPairingRecord(
                token: token,
                hostPublicKey: hostKey.publicKey.x963Representation,
                tailnetFQDN: "mac.tailnet.ts.net",
                tailnetIPv4: "100.64.0.10"
            ))
            let client = PairingClient(tokenStore: store, deviceKeyProvider: InMemoryDeviceSigningKeyProvider(), resolver: StaticResolver())

            client.applyRejection(SessionRejected(reason: reason))

            #expect(client.state == .pairedDisconnected)
            #expect(try store.load()?.token == token)
        }
    }

    @Test func iCloudPairingReaderReturnsValidPairingURL() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let relativePath = "AgentDesk/pairing/latest.json"
        let fileURL = root.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let pairingURL = URL(string: "agentdesk://pair?p=abc")!
        let document = ICloudPairingDocument(
            createdAt: Date(timeIntervalSince1970: 1_800_000_000),
            expiresAt: Date(timeIntervalSince1970: 1_800_000_300),
            hostName: "MacBook",
            pairingURL: pairingURL,
            payloadHash: ICloudPairingDocument.payloadHash(for: pairingURL),
            consumed: false
        )
        try JSONEncoder().encode(document).write(to: fileURL)
        let reader = ICloudPairingReader(
            containerIdentifier: "iCloud.com.example.agentdesk.AgentDesk",
            relativePath: relativePath,
            ubiquityContainer: { _ in root },
            now: { Date(timeIntervalSince1970: 1_800_000_100) }
        )

        #expect(try reader.readPairingURL() == pairingURL)
    }

    @Test func iCloudPairingReaderMapsMissingUnavailableExpiredAndMalformedFiles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let relativePath = "AgentDesk/pairing/latest.json"

        let unavailable = ICloudPairingReader(
            containerIdentifier: "iCloud.com.example.agentdesk.AgentDesk",
            relativePath: relativePath,
            ubiquityContainer: { _ in nil },
            now: { Date(timeIntervalSince1970: 1_800_000_100) }
        )
        #expect(throws: ICloudPairingReaderError.iCloudUnavailable) {
            _ = try unavailable.readPairingURL()
        }

        let missing = ICloudPairingReader(
            containerIdentifier: "iCloud.com.example.agentdesk.AgentDesk",
            relativePath: relativePath,
            ubiquityContainer: { _ in root },
            now: { Date(timeIntervalSince1970: 1_800_000_100) }
        )
        #expect(throws: ICloudPairingReaderError.noPairingFile) {
            _ = try missing.readPairingURL()
        }

        let fileURL = root.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let expiredURL = URL(string: "agentdesk://pair?p=expired")!
        let expired = ICloudPairingDocument(
            createdAt: Date(timeIntervalSince1970: 1_800_000_000),
            expiresAt: Date(timeIntervalSince1970: 1_800_000_010),
            hostName: "MacBook",
            pairingURL: expiredURL,
            payloadHash: ICloudPairingDocument.payloadHash(for: expiredURL),
            consumed: false
        )
        try JSONEncoder().encode(expired).write(to: fileURL)
        #expect(throws: ICloudPairingReaderError.expired) {
            _ = try missing.readPairingURL()
        }

        try Data("not-json".utf8).write(to: fileURL)
        #expect(throws: ICloudPairingReaderError.malformed) {
            _ = try missing.readPairingURL()
        }

        let unsupportedSchemaURL = URL(string: "agentdesk://pair?p=unsupported")!
        let unsupportedSchema = ICloudPairingDocument(
            schemaVersion: 2,
            createdAt: Date(timeIntervalSince1970: 1_800_000_000),
            expiresAt: Date(timeIntervalSince1970: 1_800_000_300),
            hostName: "MacBook",
            pairingURL: unsupportedSchemaURL,
            payloadHash: ICloudPairingDocument.payloadHash(for: unsupportedSchemaURL),
            consumed: false
        )
        try JSONEncoder().encode(unsupportedSchema).write(to: fileURL)
        #expect(throws: ICloudPairingReaderError.malformed) {
            _ = try missing.readPairingURL()
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

private actor MediaRefreshRequests {
    private var storage: [MediaCapabilityRefreshRequest] = []

    var values: [MediaCapabilityRefreshRequest] {
        storage
    }

    func append(_ request: MediaCapabilityRefreshRequest) {
        storage.append(request)
    }
}

@MainActor
private func waitUntil(
    timeoutNs: UInt64 = 1_000_000_000,
    predicate: @escaping @Sendable () async -> Bool
) async throws {
    let startedAt = DispatchTime.now().uptimeNanoseconds
    while !(await predicate()) {
        if DispatchTime.now().uptimeNanoseconds &- startedAt > timeoutNs {
            throw SessionRejected(reason: .malformed)
        }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
}
