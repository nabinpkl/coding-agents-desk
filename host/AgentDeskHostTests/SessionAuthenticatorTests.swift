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
        #expect(!ready.sessionId.isEmpty)
        #expect(!ready.inputCapability.isEmpty)
        #expect(ready.inputCapabilityExpiresAt == Int(fixture.clock.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970))
        #expect(active.sessionId == ready.sessionId)
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

@MainActor
struct SessionRegistryTests {
    @Test func inputCapabilityWithoutActiveSessionIsRejected() {
        let registry = SessionRegistry()
        let result = registry.validateInputCapability(InputChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-1",
            inputCapability: "capability"
        ))

        #expect(result == .rejected(.unauthorized))
    }

    @Test func acceptedInputCapabilityRotatesAndRejectsReuse() throws {
        let random = ByteSequence()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now }, randomBytes: random.bytes(count:))
        let fingerprint = DeviceFingerprint("device-fp")
        registry.noteReady(
            ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970)),
            channel: FakeSignalingChannel(),
            inputCapability: "capability-1",
            inputCapabilityExpiresAt: Int(now.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        )

        let initialHello = InputChannelHello(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            inputCapability: "capability-1"
        )
        #expect(registry.validateInputCapability(initialHello) == .accepted(fingerprint))
        #expect(registry.validateInputCapability(initialHello) == .rejected(.staleInputCapability))

        let rotatedCapability = Data(repeating: 1, count: 32).base64URLEncodedString()
        let rotatedHello = InputChannelHello(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            inputCapability: rotatedCapability
        )
        #expect(registry.validateInputCapability(rotatedHello) == .accepted(fingerprint))
    }

    @Test func expiredInputCapabilityIsRejected() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now })
        let fingerprint = DeviceFingerprint("device-fp")
        registry.noteReady(
            ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970)),
            channel: FakeSignalingChannel(),
            inputCapability: "capability-1",
            inputCapabilityExpiresAt: Int(now.timeIntervalSince1970) - 1
        )

        let result = registry.validateInputCapability(InputChannelHello(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            inputCapability: "capability-1"
        ))

        #expect(result == .rejected(.expiredInputCapability))
    }

    @Test func refreshRotatesCapabilityForActiveSessionOnly() throws {
        let random = ByteSequence()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now }, randomBytes: random.bytes(count:))
        let fingerprint = DeviceFingerprint("device-fp")
        registry.noteReady(
            ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970)),
            channel: FakeSignalingChannel(),
            inputCapability: "capability-1",
            inputCapabilityExpiresAt: Int(now.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        )

        let refresh = registry.refreshInputCapability(deviceFingerprint: fingerprint, sessionId: "session-1")
        guard case .success(let grant) = refresh else {
            #expect(Bool(false))
            return
        }
        #expect(grant.sessionId == "session-1")
        #expect(grant.inputCapability == Data(repeating: 1, count: 32).base64URLEncodedString())
        #expect(grant.inputCapabilityExpiresAt == Int(now.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970))

        let staleHello = InputChannelHello(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            inputCapability: "capability-1"
        )
        #expect(registry.validateInputCapability(staleHello) == .rejected(.staleInputCapability))

        let wrongSessionRefresh = registry.refreshInputCapability(deviceFingerprint: fingerprint, sessionId: "session-2")
        guard case .failure(let reason) = wrongSessionRefresh else {
            #expect(Bool(false))
            return
        }
        #expect(reason == .unauthorized)
    }

    @Test func staleSessionCloseDoesNotClearNewerSession() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now })
        let fingerprint = DeviceFingerprint("device-fp")
        let oldChannel = FakeSignalingChannel()
        registry.noteReady(
            ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970)),
            channel: oldChannel,
            inputCapability: "capability-1",
            inputCapabilityExpiresAt: Int(now.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        )
        registry.noteReady(
            ActiveSession(sessionId: "session-2", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970)),
            channel: FakeSignalingChannel(),
            inputCapability: "capability-2",
            inputCapabilityExpiresAt: Int(now.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        )

        #expect(oldChannel.closed)
        registry.endSession(fingerprint, sessionId: "session-1")

        let refresh = registry.refreshInputCapability(deviceFingerprint: fingerprint, sessionId: "session-2")
        guard case .success = refresh else {
            #expect(Bool(false))
            return
        }
    }

    @Test func staleInputCapabilitiesArePrunedAfterOriginalExpiry() throws {
        let random = ByteSequence()
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { clock }, randomBytes: random.bytes(count:))
        let fingerprint = DeviceFingerprint("device-fp")
        registry.noteReady(
            ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(clock.timeIntervalSince1970)),
            channel: FakeSignalingChannel(),
            inputCapability: "capability-1",
            inputCapabilityExpiresAt: Int(clock.addingTimeInterval(5).timeIntervalSince1970)
        )
        let hello = InputChannelHello(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            inputCapability: "capability-1"
        )

        #expect(registry.validateInputCapability(hello) == .accepted(fingerprint))
        #expect(registry.validateInputCapability(hello) == .rejected(.staleInputCapability))

        clock = clock.addingTimeInterval(6)
        #expect(registry.validateInputCapability(hello) == .rejected(.unauthorized))
    }

    @Test func sessionEndClearsStaleInputCapabilitiesForFingerprint() throws {
        let random = ByteSequence()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now }, randomBytes: random.bytes(count:))
        let fingerprint = DeviceFingerprint("device-fp")
        let active = ActiveSession(
            sessionId: "session-1",
            deviceFingerprint: fingerprint,
            establishedAt: Int(now.timeIntervalSince1970)
        )
        registry.noteReady(
            active,
            channel: FakeSignalingChannel(),
            inputCapability: "capability-1",
            inputCapabilityExpiresAt: Int(now.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        )
        let hello = InputChannelHello(
            deviceFingerprint: fingerprint,
            sessionId: "session-1",
            inputCapability: "capability-1"
        )
        #expect(registry.validateInputCapability(hello) == .accepted(fingerprint))

        registry.endSession(fingerprint)
        registry.noteReady(
            active,
            channel: FakeSignalingChannel(),
            inputCapability: "capability-1",
            inputCapabilityExpiresAt: Int(now.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        )

        #expect(registry.validateInputCapability(hello) == .accepted(fingerprint))
    }

    @Test func revocationSessionEndTearsDownActiveSurfacesAndBlocksRefresh() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let registry = SessionRegistry(now: { now })
        let fingerprint = DeviceFingerprint("device-fp")
        let signaling = FakeSignalingChannel()
        let inputServer = FakeInputChannelServer()
        let mediaTransport = FakeMediaTransport()
        let inputTask = Task<Void, Never> {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
        }
        registry.noteReady(
            ActiveSession(sessionId: "session-1", deviceFingerprint: fingerprint, establishedAt: Int(now.timeIntervalSince1970)),
            channel: signaling,
            inputCapability: "capability-1",
            inputCapabilityExpiresAt: Int(now.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        )
        registry.attachInputChannelServer(inputServer, for: fingerprint)
        registry.attachTransport(mediaTransport, for: fingerprint)
        registry.attachInputTask(inputTask, for: fingerprint)

        registry.endSession(fingerprint, closeSignaling: true)

        #expect(signaling.closed)
        #expect(inputServer.closed)
        #expect(mediaTransport.stopped)
        #expect(inputTask.isCancelled)
        #expect(!registry.isActive(fingerprint))
        let refresh = registry.refreshInputCapability(deviceFingerprint: fingerprint, sessionId: "session-1")
        guard case .failure(let reason) = refresh else {
            #expect(Bool(false))
            return
        }
        #expect(reason == .unauthorized)
    }
}

private final class ByteSequence {
    private var next: UInt8 = 1

    func bytes(count: Int) throws -> Data {
        defer { next &+= 1 }
        return Data(repeating: next, count: count)
    }
}

private final class FakeSignalingChannel: SignalingChannel, @unchecked Sendable {
    let inbound: AsyncStream<WebRTCSignalingFrame>
    private let continuation: AsyncStream<WebRTCSignalingFrame>.Continuation
    private(set) var closed = false

    init() {
        var continuation: AsyncStream<WebRTCSignalingFrame>.Continuation!
        inbound = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func send(_ frame: WebRTCSignalingFrame) async throws {}

    func close() {
        closed = true
        continuation.finish()
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
}

private final class FakeMediaTransport: MediaTransport, @unchecked Sendable {
    let connectionState: AsyncStream<MediaConnectionState>
    private(set) var stopped = false

    init() {
        connectionState = AsyncStream { _ in }
    }

    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
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
