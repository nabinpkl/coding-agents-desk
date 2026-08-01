import CryptoKit
import Foundation
import Network
import Security
import OSLog
import AgentDeskWire

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
        let connection = try await openPairingConnection(host: host, port: port)
        defer { connection.applicationError = .init(code: 0, reason: "pairing-done") }
        let control = try await connection.openStream()
        try await QuicSessionStreamIO.send(request, role: .control, on: control)
        let responseData = try await receiveControlPayload(on: control)
        return try JSONDecoder().decode(PairingHandshakeResponse.self, from: responseData)
    }

    /// Dials for a pairing handshake, redialing if the dial comes up blocked.
    ///
    /// Pairing is one-shot -- nothing retries behind it, and a failure is one the user has to
    /// trigger again from the Mac -- so it cannot just abandon a blocked dial the way the
    /// session reconnect loop does. It redials itself instead.
    ///
    /// Blocked is worth abandoning quickly here for a reason specific to how pairing starts
    /// (ADR-0019): the Mac dials the phone over the tailnet and pushes the offer, and only then
    /// does the phone dial back. A working path between the two was demonstrated seconds ago in
    /// the opposite direction, so a dial that cannot proceed is far more likely wedged than
    /// waiting on a tailnet that has yet to come up.
    ///
    /// Only `SessionConnectionBlocked` is retried, and only because it is raised before the
    /// connection is ready: nothing has been sent, so the one-time nonce in the request is
    /// still unspent. Retrying any later failure risks burning it.
    @available(iOS 26.0, *)
    private func openPairingConnection(host: String, port: UInt16) async throws -> NetworkConnection<QUIC> {
        var lastBlocked: SessionConnectionBlocked?
        for _ in 0..<Config.pairingBlockedDialRetries {
            do {
                return try await openConnection(
                    host: host,
                    port: port,
                    abandonWhenBlockedAfterMs: Config.sessionConnectionWaitingTimeoutMs
                )
            } catch let blocked as SessionConnectionBlocked {
                lastBlocked = blocked
            }
        }
        // The final attempt gets the full budget: if redialing did not clear the block, the
        // problem is not a wedged connection and giving up early would only fail sooner.
        do {
            return try await openConnection(host: host, port: port, abandonWhenBlockedAfterMs: nil)
        } catch let timeout as SessionConnectionReadyTimeout {
            throw lastBlocked ?? timeout
        }
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
        let connection = try await openConnection(
            host: host,
            port: port,
            abandonWhenBlockedAfterMs: Config.sessionConnectionWaitingTimeoutMs
        )
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
        try SessionHostSignatureVerifier.verifyReadySignature(
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
        let graphicsStream = try await connection.openStream()
        let domMirror = try await Self.openDomMirrorIfEnabled(connection)
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
            graphicsStream: graphicsStream,
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
                mediaKeySalt: ready.mediaKeySalt,
                clientNonce: clientNonce,
                hostNonce: challenge.hostNonce
            ),
            domMirror: domMirror
        )
    }

    // ADR-0038: open a dedicated .dom stream only when the client opted in. The host still gates it
    // (rejects when its own flag is off), which DomMirrorClient handles by stopping.
    @available(iOS 26.0, *)
    private static func openDomMirrorIfEnabled(_ connection: NetworkConnection<QUIC>) async throws -> DomMirrorClient? {
        guard SettingsStore.shared.domMirrorEnabled else { return nil }
        let stream = try await connection.openStream()
        return DomMirrorClient(stream: stream)
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
        let connection = try await openConnection(
            host: host,
            port: port,
            abandonWhenBlockedAfterMs: Config.sessionConnectionWaitingTimeoutMs
        )
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
        try SessionHostSignatureVerifier.verifySignature(
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
        try SessionHostSignatureVerifier.verifyReadySignature(
            ready,
            hostPublicKey: hostPub,
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint,
            clientNonce: clientNonce,
            hostNonce: challenge.hostNonce,
            protocolVersion: Config.protocolVersion
        )

        let inputStream = try await connection.openStream()
        let graphicsStream = try await connection.openStream()
        let domMirror = try await Self.openDomMirrorIfEnabled(connection)
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
            graphicsStream: graphicsStream,
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
                mediaKeySalt: ready.mediaKeySalt,
                clientNonce: clientNonce,
                hostNonce: challenge.hostNonce
            ),
            domMirror: domMirror
        )
    }

    /// - Parameter abandonWhenBlockedAfterMs: how long the dial may sit blocked in `.waiting`
    ///   before being abandoned for a fresh one, or `nil` to allow it the whole budget.
    ///
    ///   Abandoning early is only useful to a caller that will redial, since a fresh dial is
    ///   what actually clears a block. The session dials get it for free from the reconnect
    ///   loop; pairing does its own redialing in `openPairingConnection` and passes `nil` only
    ///   on its last, patient attempt.
    @available(iOS 26.0, *)
    private func openConnection(
        host: String,
        port: UInt16,
        abandonWhenBlockedAfterMs: Int?
    ) async throws -> NetworkConnection<QUIC> {
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
        try await waitUntilReady(connection, abandonWhenBlockedAfterMs: abandonWhenBlockedAfterMs)
        // ADR-0088: the one platform report that DOES work on the new API. Unlike
        // `dataTransferReport()` (which returns a zero-length window and all-zero fields),
        // `establishmentReport()` describes a completed fact rather than an interval, and the
        // gate harness measured it returning real values. One shot per session: how long the
        // connect took and how many attempts it needed is a cheap prior for reading everything
        // that follows on a link we already suspect.
        if let report = try? await connection.establishmentReport() {
            Logger(subsystem: Config.logSubsystem, category: "link-telemetry")
                .notice("session established durationMs=\(report.duration * 1000, format: .fixed(precision: 1), privacy: .public) previousAttempts=\(report.previousAttemptCount, privacy: .public) handshakes=\(report.handshakes.count, privacy: .public) resolutions=\(report.resolutions.count, privacy: .public)")
        }
        return connection
    }

    @available(iOS 26.0, *)
    private func waitUntilReady(
        _ connection: NetworkConnection<QUIC>,
        abandonWhenBlockedAfterMs: Int?
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let gate = ResumeGate()
            let blocked = BlockedDialWatchdog()
            let timeoutTask = Task { [gate, blocked] in
                try? await Task.sleep(nanoseconds: UInt64(Config.sessionConnectionReadyTimeoutMs) * 1_000_000)
                guard !Task.isCancelled, gate.claim() else { return }
                blocked.disarm()
                continuation.resume(throwing: SessionConnectionReadyTimeout())
            }
            connection.onStateUpdate { _, state in
                switch SessionConnectionReadiness.decision(for: state) {
                case .ready:
                    timeoutTask.cancel()
                    blocked.disarm()
                    if gate.claim() { continuation.resume() }
                case .fail(let error):
                    timeoutTask.cancel()
                    blocked.disarm()
                    if gate.claim() { continuation.resume(throwing: error) }
                case .blocked(let reason):
                    guard let budgetMs = abandonWhenBlockedAfterMs else { break }
                    blocked.arm {
                        Task { [gate] in
                            try? await Task.sleep(nanoseconds: UInt64(budgetMs) * 1_000_000)
                            guard !Task.isCancelled, gate.claim() else { return }
                            timeoutTask.cancel()
                            continuation.resume(
                                throwing: SessionConnectionBlocked(reason: reason, afterMs: budgetMs)
                            )
                        }
                    }
                case .keepWaiting:
                    // Back to making progress, so the block is over and only the overall
                    // budget applies again.
                    blocked.disarm()
                }
            }
            connection.start()
        }
    }

    @available(iOS 26.0, *)
    private func receiveControlPayload(on stream: QUIC.Stream<QUICStream>) async throws -> Data {
        let frame = try await QuicSessionStreamIO.receiveFrame(on: stream, expectedRole: .control)
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

enum SessionHostSignatureVerifier {
    static func verifyReadySignature(
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

    static func verifySignature(
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
}

enum SessionConnectionReadinessDecision: Equatable {
    /// The dial is making progress. Only the overall budget applies.
    case keepWaiting
    /// The dial is stalled and will resume only if conditions change, carrying the reason the
    /// transport gave. Bounded separately and much more tightly than progress, because a
    /// blocked connection does not recover when conditions do -- a fresh dial does.
    case blocked(String)
    case ready
    case fail(String)
}

enum SessionConnectionReadinessEvent {
    case setup
    case preparing
    case waiting(String)
    case ready
    case failed(String)
    case cancelled
}

enum SessionConnectionReadiness {
    static func decision(for event: SessionConnectionReadinessEvent) -> SessionConnectionReadinessDecision {
        switch event {
        case .ready:
            .ready
        case .failed(let description):
            .fail(description)
        case .cancelled:
            .fail(String(describing: CancellationError()))
        case .waiting(let reason):
            .blocked(reason)
        case .setup, .preparing:
            .keepWaiting
        }
    }

    @available(iOS 26.0, *)
    static func decision(for state: NetworkChannel<QUIC>.State) -> SessionConnectionReadyRuntimeDecision {
        switch state {
        case .ready:
            .ready
        case .failed(let error):
            .fail(error)
        case .cancelled:
            .fail(CancellationError())
        case .waiting(let error):
            .blocked(String(describing: error))
        case .setup, .preparing:
            .keepWaiting
        default:
            .keepWaiting
        }
    }
}

@available(iOS 26.0, *)
enum SessionConnectionReadyRuntimeDecision {
    case keepWaiting
    case blocked(String)
    case ready
    case fail(Error)
}

struct SessionConnectionReadyTimeout: Error, CustomStringConvertible {
    var description: String {
        "session connection did not become ready within \(Config.sessionConnectionReadyTimeoutMs)ms"
    }
}

/// A dial abandoned because it was blocked rather than slow.
///
/// Distinct from `SessionConnectionReadyTimeout` so a diagnostics pull says which bound fired,
/// and carries the transport's own reason so the cause is readable from the client alone --
/// establishing that a blocked dial was `waiting(ENETDOWN)` previously took a host log.
struct SessionConnectionBlocked: Error, CustomStringConvertible {
    let reason: String
    let afterMs: Int

    var description: String {
        "session connection blocked in waiting(\(reason)) for \(afterMs)ms"
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
