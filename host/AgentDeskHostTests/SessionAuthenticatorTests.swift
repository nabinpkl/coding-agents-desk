import CryptoKit
import Foundation
import Testing

@testable import AgentDeskHost

struct SessionAuthenticatorTests {
    @Test func allowlistedDeviceCompletesHandshakeAndReturnsSessionReadyMaterial() throws {
        let fixture = try Fixture()
        let challenge = try fixture.authenticator.processInit(fixture.makeSessionInit(clientNonce: fixture.clientNonce))
        let proof = try fixture.signProof(hostNonce: challenge.hostNonce, clientNonce: fixture.clientNonce)
        let (ready, active, pending) = try fixture.authenticator.processProof(proof)

        #expect(ready.type == "session-ready")
        #expect(!ready.sessionId.isEmpty)
        #expect(ready.resumeToken.count == 32)
        #expect(ready.resumeExpiresAt == Int(fixture.clock.addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970))
        #expect(ready.mediaKeySalt.count == 32)
        #expect(active.sessionId == ready.sessionId)
        #expect(active.deviceFingerprint == fixture.deviceFingerprint)
        #expect(active.establishedAt == Int(fixture.clock.timeIntervalSince1970))
        #expect(pending.clientNonce == fixture.clientNonce)
        #expect(pending.hostNonce == challenge.hostNonce)
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

    @Test func clientBelowMinProtocolVersionIsRejected() throws {
        let fixture = try Fixture()
        let staleInit = SessionInit(
            deviceFingerprint: fixture.deviceFingerprint,
            sessionToken: fixture.sessionToken,
            clientNonce: fixture.clientNonce,
            protocolVersion: Config.minCompatibleProtocolVersion - 1
        )
        #expect(throws: SessionRejected(reason: .incompatibleProtocol)) {
            try fixture.authenticator.processInit(staleInit)
        }
    }

    @Test func challengeCarriesHostProtocolVersion() throws {
        let fixture = try Fixture()
        let challenge = try fixture.authenticator.processInit(fixture.makeSessionInit(clientNonce: fixture.clientNonce))

        #expect(challenge.protocolVersion == Config.protocolVersion)
    }

    @Test func garbageClientSignatureReturnsBadSignatureRejection() throws {
        let fixture = try Fixture()
        _ = try fixture.authenticator.processInit(fixture.makeSessionInit(clientNonce: fixture.clientNonce))
        let garbageProof = SessionProof(clientSignature: Data(repeating: 0xab, count: 64))

        #expect(throws: SessionRejected(reason: .badSignature)) {
            try fixture.authenticator.processProof(garbageProof)
        }
    }

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

@MainActor
struct SessionRegistryTests {
    @Test func readySessionBecomesConnectedAndStoresResumeMaterial() throws {
        let random = ByteSequence()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now }, randomBytes: random.bytes(count:))
        let fingerprint = DeviceFingerprint("device-fp")
        let active = ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970))
        let ready = SessionReady(
            sessionId: "session-1",
            resumeToken: Data(repeating: 7, count: 32),
            resumeExpiresAt: Int(now.addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970),
            mediaKeySalt: Data(repeating: 8, count: 32)
        )

        registry.noteAttempt(fingerprint)
        registry.noteReady(active, ready: ready)

        #expect(registry.state(for: fingerprint) == .connected)
        #expect(registry.isActive(fingerprint))
        #expect(!registry.isAttempting(fingerprint))
        #expect(registry.validateResume(SessionResumeInit(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            resumeToken: ready.resumeToken
        )) == .accepted(active))
    }

    @Test func suspendClosesLanesButKeepsSessionResumable() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now })
        let fingerprint = DeviceFingerprint("device-fp")
        let active = ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970))
        let ready = SessionReady(
            sessionId: "session-1",
            resumeToken: Data(repeating: 7, count: 32),
            resumeExpiresAt: Int(now.addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970),
            mediaKeySalt: Data(repeating: 8, count: 32)
        )
        let inputServer = FakeInputChannelServer()
        let mediaTransport = FakeMediaTransport()
        let inputTask = Task<Void, Never> {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
        }

        registry.noteReady(active, ready: ready, transport: mediaTransport)
        registry.attachInputChannelServer(inputServer, for: fingerprint)
        registry.attachInputTask(inputTask, for: fingerprint)
        registry.markSuspended(fingerprint, sessionId: "session-1")

        #expect(registry.state(for: fingerprint) == .suspended)
        #expect(!registry.isActive(fingerprint))
        #expect(inputServer.closed)
        #expect(mediaTransport.stopped)
        #expect(inputTask.isCancelled)
        #expect(registry.validateResume(SessionResumeInit(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            resumeToken: ready.resumeToken
        )) == .accepted(active))
    }

    @Test func forgedStaleAndIncompatibleResumeTokensAreRejected() {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now })
        let fingerprint = DeviceFingerprint("device-fp")
        let active = ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970))
        let ready = SessionReady(
            sessionId: "session-1",
            resumeToken: Data(repeating: 7, count: 32),
            resumeExpiresAt: Int(now.addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970),
            mediaKeySalt: Data(repeating: 8, count: 32)
        )
        registry.noteReady(active, ready: ready)

        #expect(registry.validateResume(SessionResumeInit(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            resumeToken: Data(repeating: 9, count: 32)
        )) == .rejected(.unauthorized))

        #expect(registry.validateResume(SessionResumeInit(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            resumeToken: ready.resumeToken,
            protocolVersion: Config.minCompatibleProtocolVersion - 1
        )) == .rejected(.incompatibleProtocol))

        now = now.addingTimeInterval(Config.sessionResumeTTL + 1)
        #expect(registry.validateResume(SessionResumeInit(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            resumeToken: ready.resumeToken
        )) == .rejected(.expiredResume))
    }

    @Test func noteResumedReusesSessionIdAndRotatesResumeMaterial() throws {
        let random = ByteSequence()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now }, randomBytes: random.bytes(count:))
        let fingerprint = DeviceFingerprint("device-fp")
        let active = ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970))
        let ready = SessionReady(
            sessionId: "session-1",
            resumeToken: Data(repeating: 7, count: 32),
            resumeExpiresAt: Int(now.addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970),
            mediaKeySalt: Data(repeating: 8, count: 32)
        )
        registry.noteReady(active, ready: ready)
        registry.markSuspended(fingerprint, sessionId: "session-1")
        #expect(registry.validateResume(SessionResumeInit(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            resumeToken: ready.resumeToken
        )) == .accepted(active))

        let resumedReady = try registry.makeResumeReady(for: fingerprint)
        registry.noteResumed(fingerprint, ready: resumedReady)

        #expect(resumedReady.sessionId == "session-1")
        #expect(resumedReady.resumeToken == Data(repeating: 1, count: 32))
        #expect(resumedReady.mediaKeySalt == Data(repeating: 2, count: 32))
        #expect(registry.state(for: fingerprint) == .connected)
        #expect(registry.validateResume(SessionResumeInit(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            resumeToken: ready.resumeToken
        )) == .rejected(.unauthorized))
    }

    @Test func endSessionTearsDownActiveSurfacesAndRejectsResume() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now })
        let fingerprint = DeviceFingerprint("device-fp")
        let active = ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970))
        let ready = SessionReady(
            sessionId: "session-1",
            resumeToken: Data(repeating: 7, count: 32),
            resumeExpiresAt: Int(now.addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970),
            mediaKeySalt: Data(repeating: 8, count: 32)
        )
        let inputServer = FakeInputChannelServer()
        let mediaTransport = FakeMediaTransport()
        let inputTask = Task<Void, Never> {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
        }

        registry.noteReady(active, ready: ready, transport: mediaTransport)
        registry.attachInputChannelServer(inputServer, for: fingerprint)
        registry.attachInputTask(inputTask, for: fingerprint)
        registry.endSession(fingerprint, sessionId: "session-1")

        #expect(registry.state(for: fingerprint) == nil)
        #expect(inputServer.closed)
        #expect(mediaTransport.stopped)
        #expect(inputTask.isCancelled)
        #expect(registry.validateResume(SessionResumeInit(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            resumeToken: ready.resumeToken
        )) == .rejected(.unauthorized))
    }
}

private final class ByteSequence {
    private var next: UInt8 = 1

    func bytes(count: Int) throws -> Data {
        defer { next &+= 1 }
        return Data(repeating: next, count: count)
    }
}

private final class FakeInputChannelServer: InputChannelServing, @unchecked Sendable {
    let events: AsyncStream<NormalizedInput>
    private let continuation: AsyncStream<NormalizedInput>.Continuation
    private(set) var closed = false
    var configHandler: ((ClientConfig) -> Void)?

    init() {
        var continuation: AsyncStream<NormalizedInput>.Continuation!
        events = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func close() {
        closed = true
        continuation.finish()
    }

    func pushDesktopState(_ state: DesktopState) {}

    func pushThumbnails(_ thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow]) {}

    func pushAgentSay(_ push: AgentSayPush) {}

    func pushCursor(_ push: CursorImagePush) {}
}

private final class FakeMediaTransport: MediaTransport, @unchecked Sendable {
    let connectionState: AsyncStream<MediaConnectionState>
    private(set) var stopped = false

    init() {
        connectionState = AsyncStream { _ in }
    }

    func start(
        videoSource: VideoFrameSource?,
        videoSink: VideoFrameSink?
    ) async throws {}

    func stop() {
        stopped = true
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
