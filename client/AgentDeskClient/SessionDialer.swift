import CryptoKit
import Foundation
import Network
import Security

@MainActor
final class SessionDialer {
    private let randomBytes: (Int) throws -> Data
    private let now: () -> Date

    init(
        randomBytes: @escaping (Int) throws -> Data = SessionDialer.systemRandomBytes,
        now: @escaping () -> Date = Date.init
    ) {
        self.randomBytes = randomBytes
        self.now = now
    }

    @available(iOS 26.0, *)
    func performPairingHandshake(
        host: String,
        port: UInt16,
        request: PairingHandshakeRequest
    ) async throws -> PairingHandshakeResponse {
        let connection = try await openConnection(host: host, port: port)
        defer { connection.applicationError = .init(code: 0, reason: "pairing-done") }
        let control = try await connection.openStream()
        try await QuicSessionStreamIO.send(request, role: .control, on: control)
        let responseData = try await receiveControlPayload(on: control)
        return try JSONDecoder().decode(PairingHandshakeResponse.self, from: responseData)
    }

    @available(iOS 26.0, *)
    func dial(
        host: String,
        port: UInt16,
        deviceFingerprint: DeviceFingerprint,
        sessionToken: SessionToken,
        hostPublicKey: Data,
        deviceKey: DeviceSigningKeyProviding
    ) async throws -> SessionHandshakeOutcome {
        let hostPub: P256.Signing.PublicKey
        do {
            hostPub = try P256.Signing.PublicKey(x963Representation: hostPublicKey)
        } catch {
            throw SessionRejected(reason: .badSignature)
        }
        let hostFingerprint = hostPub.agentDeskFingerprint
        let connection = try await openConnection(host: host, port: port)
        var success = false
        defer {
            if !success {
                connection.applicationError = .init(code: 1, reason: "session-failed")
            }
        }

        let control = try await connection.openStream()
        let clientNonce = try randomBytes(32)
        try await QuicSessionStreamIO.send(
            SessionInit(
                deviceFingerprint: deviceFingerprint,
                sessionToken: sessionToken,
                clientNonce: clientNonce
            ),
            role: .control,
            on: control
        )

        let challenge = try decodeControl(SessionChallenge.self, expectedType: "session-challenge", from: try await receiveControlPayload(on: control))
        guard challenge.protocolVersion >= Config.minCompatibleProtocolVersion else {
            throw SessionRejected(reason: .incompatibleProtocol)
        }
        let signingInput = SessionSigning.canonicalInput(
            clientNonce: clientNonce,
            hostNonce: challenge.hostNonce,
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint
        )
        let hostSig: P256.Signing.ECDSASignature
        do {
            hostSig = try P256.Signing.ECDSASignature(rawRepresentation: challenge.hostSignature)
        } catch {
            throw SessionRejected(reason: .badSignature)
        }
        guard hostPub.isValidSignature(hostSig, for: signingInput) else {
            throw SessionRejected(reason: .badSignature)
        }

        try await QuicSessionStreamIO.send(
            SessionProof(clientSignature: try deviceKey.signature(for: signingInput).rawRepresentation),
            role: .control,
            on: control
        )

        let ready = try decodeControl(SessionReady.self, expectedType: "session-ready", from: try await receiveControlPayload(on: control))
        try verifyReadySignature(
            ready,
            hostPublicKey: hostPub,
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint,
            clientNonce: clientNonce,
            hostNonce: challenge.hostNonce,
            protocolVersion: challenge.protocolVersion
        )
        let active = ActiveSession(
            sessionId: ready.sessionId,
            deviceFingerprint: deviceFingerprint,
            establishedAt: Int(now().timeIntervalSince1970)
        )
        let inputStream = try await connection.openStream()
        let datagrams = try await connection.datagrams
        let mediaKey = MediaDatagramCrypto.sessionKey(
            sessionId: ready.sessionId,
            clientNonce: clientNonce,
            hostNonce: challenge.hostNonce,
            mediaKeySalt: ready.mediaKeySalt
        )
        let transport = QuicSessionClientTransport(
            connection: connection,
            inputStream: inputStream,
            datagrams: datagrams,
            activeSession: active,
            mediaKey: mediaKey
        )
        success = true
        return SessionHandshakeOutcome(
            active: active,
            transport: transport,
            resume: SessionResumeMaterial(
                id: ready.resumeId,
                secret: ready.resumeSecret,
                expiresAt: ready.resumeExpiresAt,
                mediaKeySalt: ready.mediaKeySalt,
                clientNonce: clientNonce,
                hostNonce: challenge.hostNonce
            )
        )
    }

    @available(iOS 26.0, *)
    func resume(
        host: String,
        port: UInt16,
        deviceFingerprint: DeviceFingerprint,
        active: ActiveSession,
        resume: SessionResumeMaterial,
        hostPublicKey: Data
    ) async throws -> SessionHandshakeOutcome {
        let hostPub: P256.Signing.PublicKey
        do {
            hostPub = try P256.Signing.PublicKey(x963Representation: hostPublicKey)
        } catch {
            throw SessionRejected(reason: .badSignature)
        }
        let hostFingerprint = hostPub.agentDeskFingerprint
        let connection = try await openConnection(host: host, port: port)
        var success = false
        defer {
            if !success {
                connection.applicationError = .init(code: 1, reason: "resume-failed")
            }
        }

        let control = try await connection.openStream()
        let clientNonce = try randomBytes(32)
        try await QuicSessionStreamIO.send(
            SessionResumeInit(
                deviceFingerprint: deviceFingerprint,
                sessionId: active.sessionId,
                resumeId: resume.id,
                clientNonce: clientNonce
            ),
            role: .control,
            on: control
        )
        let challenge = try decodeControl(
            SessionResumeChallenge.self,
            expectedType: "session-resume-challenge",
            from: try await receiveControlPayload(on: control)
        )
        guard challenge.resumeExpiresAt >= Int(now().timeIntervalSince1970) else {
            throw SessionRejected(reason: .expiredResume)
        }
        try verifySignature(
            challenge.hostSignature,
            hostPublicKey: hostPub,
            input: SessionResumeSigning.challengeInput(
                sessionId: active.sessionId,
                deviceFingerprint: deviceFingerprint,
                resumeId: resume.id,
                clientNonce: clientNonce,
                hostNonce: challenge.hostNonce,
                resumeExpiresAt: challenge.resumeExpiresAt,
                protocolVersion: Config.protocolVersion,
                hostFingerprint: hostFingerprint
            )
        )
        let proof = SessionResumeSigning.proof(
            sessionId: active.sessionId,
            deviceFingerprint: deviceFingerprint,
            resumeId: resume.id,
            clientNonce: clientNonce,
            hostNonce: challenge.hostNonce,
            protocolVersion: Config.protocolVersion,
            secret: resume.secret
        )
        try await QuicSessionStreamIO.send(
            SessionResumeProof(proof: proof),
            role: .control,
            on: control
        )
        let ready = try decodeControl(
            SessionReady.self,
            expectedType: "session-ready",
            from: try await receiveControlPayload(on: control)
        )
        guard ready.sessionId == active.sessionId else {
            throw SessionRejected(reason: .unauthorized)
        }
        try verifyReadySignature(
            ready,
            hostPublicKey: hostPub,
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint,
            clientNonce: clientNonce,
            hostNonce: challenge.hostNonce,
            protocolVersion: Config.protocolVersion
        )

        let inputStream = try await connection.openStream()
        let datagrams = try await connection.datagrams
        let mediaKey = MediaDatagramCrypto.sessionKey(
            sessionId: ready.sessionId,
            clientNonce: clientNonce,
            hostNonce: challenge.hostNonce,
            mediaKeySalt: ready.mediaKeySalt
        )
        let transport = QuicSessionClientTransport(
            connection: connection,
            inputStream: inputStream,
            datagrams: datagrams,
            activeSession: active,
            mediaKey: mediaKey
        )
        success = true
        return SessionHandshakeOutcome(
            active: active,
            transport: transport,
            resume: SessionResumeMaterial(
                id: ready.resumeId,
                secret: ready.resumeSecret,
                expiresAt: ready.resumeExpiresAt,
                mediaKeySalt: ready.mediaKeySalt,
                clientNonce: clientNonce,
                hostNonce: challenge.hostNonce
            )
        )
    }

    @available(iOS 26.0, *)
    private func openConnection(host: String, port: UInt16) async throws -> NetworkConnection<QUIC> {
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
            throw SessionRejected(reason: .malformed)
        }
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: endpointPort)
        let connection = NetworkConnection<QUIC>(
            to: endpoint,
            using: NWParametersBuilder(auto: {
                QUIC(alpn: [Config.sessionQuicALPN])
                    .maxDatagramFrameSize(Config.ownedMediaMaxDatagramFrameSize)
                    .initialMaxBidirectionalStreams(8)
                    .idleTimeout(30_000)
                    .tls.certificateValidator { _, _ in
                        // The signed ADR-0003 application handshake authenticates the
                        // paired host key. This validator intentionally avoids IP-literal
                        // hostname failure on tailnet CGNAT addresses.
                        true
                    }
            })
        )
        try await waitUntilReady(connection)
        return connection
    }

    @available(iOS 26.0, *)
    private func waitUntilReady(_ connection: NetworkConnection<QUIC>) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let gate = ResumeGate()
            connection.onStateUpdate { _, state in
                switch state {
                case .ready:
                    if gate.claim() { continuation.resume() }
                case .failed(let error), .waiting(let error):
                    if gate.claim() { continuation.resume(throwing: error) }
                case .cancelled:
                    if gate.claim() { continuation.resume(throwing: CancellationError()) }
                default:
                    break
                }
            }
            connection.start()
        }
    }

    @available(iOS 26.0, *)
    private func receiveControlPayload(on stream: QUIC.Stream<QUICStream>) async throws -> Data {
        let frame = try await QuicSessionStreamIO.receiveFrame(on: stream)
        guard frame.role == .control else { throw SessionRejected(reason: .malformed) }
        if let rejected = try? JSONDecoder().decode(SessionRejected.self, from: frame.payload),
           rejected.type == "session-rejected" {
            throw rejected
        }
        return frame.payload
    }

    private func decodeControl<T: Decodable>(
        _ type: T.Type,
        expectedType: String,
        from data: Data
    ) throws -> T {
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        if envelope.type == "session-rejected",
           let rejected = try? JSONDecoder().decode(SessionRejected.self, from: data) {
            throw rejected
        }
        guard envelope.type == expectedType else {
            throw SessionRejected(reason: .malformed)
        }
        return try JSONDecoder().decode(type, from: data)
    }

    private func verifyReadySignature(
        _ ready: SessionReady,
        hostPublicKey: P256.Signing.PublicKey,
        hostFingerprint: String,
        deviceFingerprint: DeviceFingerprint,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int
    ) throws {
        try verifySignature(
            ready.hostSignature,
            hostPublicKey: hostPublicKey,
            input: SessionResumeSigning.readyInput(
                ready: ready,
                deviceFingerprint: deviceFingerprint,
                clientNonce: clientNonce,
                hostNonce: hostNonce,
                protocolVersion: protocolVersion,
                hostFingerprint: hostFingerprint
            )
        )
    }

    private func verifySignature(
        _ signatureData: Data,
        hostPublicKey: P256.Signing.PublicKey,
        input: Data
    ) throws {
        let signature: P256.Signing.ECDSASignature
        do {
            signature = try P256.Signing.ECDSASignature(rawRepresentation: signatureData)
        } catch {
            throw SessionRejected(reason: .badSignature)
        }
        guard hostPublicKey.isValidSignature(signature, for: input) else {
            throw SessionRejected(reason: .badSignature)
        }
    }

    private struct Envelope: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }

    nonisolated static func systemRandomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }
}

private final class ResumeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if resumed { return false }
        resumed = true
        return true
    }
}
