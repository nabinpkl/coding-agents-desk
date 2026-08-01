import Foundation
import Security
import AgentDeskWire

enum SessionLifecycleState: Equatable {
    case connecting
    case connected
    case suspended
    case resuming
    case ended
}

enum SessionResumeValidationResult: Equatable {
    case accepted(ActiveSession, hostNonce: Data)
    case rejected(SessionRejectionReason)
}

enum SessionResumeChallengeResult: Equatable {
    case accepted(SessionResumeChallenge)
    case rejected(SessionRejectionReason)
}

enum SessionReadyTransition: Equatable {
    case initial
    case sameSession
    case replaced(previousSessionID: String)
}

private struct PendingResumeProof {
    let resumeId: Data
    let clientNonce: Data
    let hostNonce: Data
}

private struct ActiveSessionRecord {
    var session: ActiveSession
    var state: SessionLifecycleState
    var resumeId: Data
    var resumeSecret: Data
    // When the host last lost contact, or nil while it believes the session is live.
    // The resume deadline is derived from this rather than stored, because the deadline
    // has to count from the moment contact was lost and the handshake cannot know that
    // moment in advance. See resumeDeadline(for:).
    var suspendedAt: Date?
    var mediaKeySalt: Data
    var pendingResumeProof: PendingResumeProof?
}

// ADR-0030: per-fingerprint live-session state. The QUIC connection owns
// liveness; input and media are lanes attached to one authenticated session.
// Capability grants are gone because lanes no longer authenticate separately.
@MainActor
final class SessionRegistry {
    private let now: () -> Date
    private let randomBytes: (Int) throws -> Data
    private var records: [DeviceFingerprint: ActiveSessionRecord] = [:]
    private var attempting: Set<DeviceFingerprint> = []
    private var resumeTimers: [DeviceFingerprint: Task<Void, Never>] = [:]
    private var inputTasks: [DeviceFingerprint: Task<Void, Never>] = [:]
    private var inputChannelServers: [DeviceFingerprint: any InputChannelServing] = [:]
    private var diagnosticsBrokers: [DeviceFingerprint: any ClientDiagnosticsCollecting] = [:]
    private var transports: [DeviceFingerprint: MediaTransport] = [:]

    init(
        now: @escaping () -> Date = Date.init,
        randomBytes: @escaping (Int) throws -> Data = SessionRegistry.systemRandomBytes
    ) {
        self.now = now
        self.randomBytes = randomBytes
    }

    func noteAttempt(_ fingerprint: DeviceFingerprint) {
        attempting.insert(fingerprint)
    }

    /// A dial that never reached `noteReady` went away. Clears only the attempt: any
    /// established or suspended session for this device belongs to a different connection and
    /// must survive, which is what keeps a resume window open across the failed dials a
    /// handover produces.
    func endAttempt(_ fingerprint: DeviceFingerprint) {
        attempting.remove(fingerprint)
    }

    func noteReady(
        _ session: ActiveSession,
        ready: SessionReady,
        transport: MediaTransport? = nil
    ) -> SessionReadyTransition {
        let transition: SessionReadyTransition
        if let prior = records[session.deviceFingerprint] {
            if prior.session.sessionId == session.sessionId {
                transition = .sameSession
            } else {
                transition = .replaced(previousSessionID: prior.session.sessionId)
                endSession(session.deviceFingerprint, sessionId: prior.session.sessionId)
            }
        } else {
            transition = .initial
        }
        attempting.remove(session.deviceFingerprint)
        resumeTimers[session.deviceFingerprint]?.cancel()
        resumeTimers.removeValue(forKey: session.deviceFingerprint)
        records[session.deviceFingerprint] = ActiveSessionRecord(
            session: session,
            state: .connected,
            resumeId: ready.resumeId,
            resumeSecret: ready.resumeSecret,
            suspendedAt: nil,
            mediaKeySalt: ready.mediaKeySalt,
            pendingResumeProof: nil
        )
        if let transport {
            transports[session.deviceFingerprint] = transport
        }
        return transition
    }

    /// Returns false when there is no matching live record, so callers do not announce a
    /// suspension or start a grace timer for a session that is already gone.
    @discardableResult
    func markSuspended(_ fingerprint: DeviceFingerprint, sessionId: String? = nil) -> Bool {
        guard var record = records[fingerprint],
              sessionId == nil || record.session.sessionId == sessionId
        else { return false }
        record.state = .suspended
        // Every fresh loss of contact opens a fresh resume window. A connection that flaps
        // is a client still trying to reach us; the session ends when the flapping stops.
        record.suspendedAt = now()
        records[fingerprint] = record
        inputTasks[fingerprint]?.cancel()
        inputTasks.removeValue(forKey: fingerprint)
        inputChannelServers[fingerprint]?.close()
        inputChannelServers.removeValue(forKey: fingerprint)
        diagnosticsBrokers[fingerprint]?.cancel()
        diagnosticsBrokers.removeValue(forKey: fingerprint)
        transports[fingerprint]?.stop()
        transports.removeValue(forKey: fingerprint)
        return true
    }

    /// How long this session stays resumable: `sessionResumeTTL` from the moment the host
    /// last had contact with the client.
    ///
    /// A record the host still believes is connected has contact now, so its window is
    /// continuously refreshed. That is correct while the host notices drops, and it is the
    /// one case a liveness echo still has to close: a session wedged as connected over a
    /// dead path holds its resume window open until the host learns the path is dead.
    private func resumeDeadline(for record: ActiveSessionRecord) -> Int {
        Int((record.suspendedAt ?? now()).addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970)
    }

    func makeResumeChallenge(_ request: SessionResumeInit) -> SessionResumeChallengeResult {
        guard var record = records[request.deviceFingerprint],
              record.session.sessionId == request.sessionId
        else {
            return .rejected(.unauthorized)
        }
        guard request.protocolVersion >= Config.minCompatibleProtocolVersion else {
            return .rejected(.incompatibleProtocol)
        }
        let deadline = resumeDeadline(for: record)
        guard Int(now().timeIntervalSince1970) <= deadline else {
            return .rejected(.expiredResume)
        }
        guard !request.resumeId.isEmpty,
              !request.clientNonce.isEmpty,
              record.resumeId == request.resumeId else {
            return .rejected(.unauthorized)
        }
        let hostNonce: Data
        do {
            hostNonce = try randomBytes(32)
        } catch {
            return .rejected(.malformed)
        }
        record.pendingResumeProof = PendingResumeProof(
            resumeId: request.resumeId,
            clientNonce: request.clientNonce,
            hostNonce: hostNonce
        )
        records[request.deviceFingerprint] = record
        return .accepted(SessionResumeChallenge(
            hostNonce: hostNonce,
            resumeExpiresAt: deadline,
            hostSignature: Data()
        ))
    }

    func validateResume(_ request: SessionResumeInit, proof: SessionResumeProof) -> SessionResumeValidationResult {
        guard var record = records[request.deviceFingerprint],
              record.session.sessionId == request.sessionId
        else {
            return .rejected(.unauthorized)
        }
        guard request.protocolVersion >= Config.minCompatibleProtocolVersion else {
            return .rejected(.incompatibleProtocol)
        }
        guard Int(now().timeIntervalSince1970) <= resumeDeadline(for: record) else {
            return .rejected(.expiredResume)
        }
        guard let pending = record.pendingResumeProof,
              pending.resumeId == request.resumeId,
              pending.clientNonce == request.clientNonce,
              record.resumeId == request.resumeId else {
            return .rejected(.unauthorized)
        }
        guard SessionResumeSigning.isValid(
            proof.proof,
            sessionId: record.session.sessionId,
            deviceFingerprint: request.deviceFingerprint,
            resumeId: request.resumeId,
            clientNonce: request.clientNonce,
            hostNonce: pending.hostNonce,
            protocolVersion: request.protocolVersion,
            secret: record.resumeSecret
        ) else {
            record.pendingResumeProof = nil
            records[request.deviceFingerprint] = record
            return .rejected(.unauthorized)
        }
        record.state = .resuming
        record.pendingResumeProof = nil
        records[request.deviceFingerprint] = record
        return .accepted(record.session, hostNonce: pending.hostNonce)
    }

    func cancelResumeChallenge(_ request: SessionResumeInit) {
        guard var record = records[request.deviceFingerprint],
              record.session.sessionId == request.sessionId,
              let pending = record.pendingResumeProof,
              pending.resumeId == request.resumeId,
              pending.clientNonce == request.clientNonce
        else {
            return
        }
        record.pendingResumeProof = nil
        records[request.deviceFingerprint] = record
    }

    func noteResumed(_ fingerprint: DeviceFingerprint, ready: SessionReady, transport: MediaTransport? = nil) {
        guard var record = records[fingerprint] else { return }
        record.state = .connected
        record.resumeId = ready.resumeId
        record.resumeSecret = ready.resumeSecret
        record.suspendedAt = nil
        record.mediaKeySalt = ready.mediaKeySalt
        record.pendingResumeProof = nil
        records[fingerprint] = record
        resumeTimers[fingerprint]?.cancel()
        resumeTimers.removeValue(forKey: fingerprint)
        if let transport {
            transports[fingerprint] = transport
        }
    }

    func scheduleResumeGrace(_ task: Task<Void, Never>, for fingerprint: DeviceFingerprint) {
        resumeTimers[fingerprint]?.cancel()
        resumeTimers[fingerprint] = task
    }

    @discardableResult
    func endSession(_ fingerprint: DeviceFingerprint, sessionId: String? = nil) -> Bool {
        if let sessionId,
           let current = records[fingerprint],
           current.session.sessionId != sessionId {
            return false
        }
        attempting.remove(fingerprint)
        records.removeValue(forKey: fingerprint)
        resumeTimers[fingerprint]?.cancel()
        resumeTimers.removeValue(forKey: fingerprint)
        inputTasks[fingerprint]?.cancel()
        inputTasks.removeValue(forKey: fingerprint)
        inputChannelServers[fingerprint]?.close()
        inputChannelServers.removeValue(forKey: fingerprint)
        diagnosticsBrokers[fingerprint]?.cancel()
        diagnosticsBrokers.removeValue(forKey: fingerprint)
        transports[fingerprint]?.stop()
        transports.removeValue(forKey: fingerprint)
        return true
    }

    func attachTransport(_ transport: MediaTransport, for fingerprint: DeviceFingerprint) {
        transports[fingerprint] = transport
    }

    func transport(for fingerprint: DeviceFingerprint) -> MediaTransport? {
        transports[fingerprint]
    }

    func attachInputTask(_ task: Task<Void, Never>, for fingerprint: DeviceFingerprint) {
        inputTasks[fingerprint]?.cancel()
        inputTasks[fingerprint] = task
    }

    func attachInputChannelServer(_ server: any InputChannelServing, for fingerprint: DeviceFingerprint) {
        inputChannelServers[fingerprint]?.close()
        inputChannelServers[fingerprint] = server
    }

    func attachDiagnosticsBroker(
        _ broker: any ClientDiagnosticsCollecting,
        for fingerprint: DeviceFingerprint
    ) {
        diagnosticsBrokers[fingerprint]?.cancel()
        diagnosticsBrokers[fingerprint] = broker
    }

    func isActive(_ fingerprint: DeviceFingerprint) -> Bool {
        records[fingerprint]?.state == .connected
    }

    func isAttempting(_ fingerprint: DeviceFingerprint) -> Bool {
        attempting.contains(fingerprint)
    }

    func state(for fingerprint: DeviceFingerprint) -> SessionLifecycleState? {
        records[fingerprint]?.state
    }

    func sessionId(for fingerprint: DeviceFingerprint) -> String? {
        records[fingerprint]?.session.sessionId
    }

    func allInputChannelServers() -> [any InputChannelServing] {
        Array(inputChannelServers.values)
    }

    func allInputChannelServersByFingerprint() -> [(DeviceFingerprint, any InputChannelServing)] {
        inputChannelServers.map { ($0.key, $0.value) }
    }

    func allDiagnosticsBrokers() -> [any ClientDiagnosticsCollecting] {
        Array(diagnosticsBrokers.values)
    }

    func diagnosticsBroker(for fingerprint: DeviceFingerprint) -> (any ClientDiagnosticsCollecting)? {
        diagnosticsBrokers[fingerprint]
    }

    func makeResumeReady(for fingerprint: DeviceFingerprint) throws -> SessionReady {
        guard let record = records[fingerprint] else {
            throw SessionRejected(reason: .unauthorized)
        }
        return SessionReady(
            sessionId: record.session.sessionId,
            resumeId: try randomBytes(32),
            resumeSecret: try randomBytes(32),
            // Advisory. The session is about to go connected, so the real deadline is
            // whatever the next loss of contact derives; the authoritative check is the
            // host's, on the challenge it issues at the next resume.
            resumeExpiresAt: Int(now().addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970),
            mediaKeySalt: try randomBytes(32),
            hostSignature: Data()
        )
    }

    nonisolated private static func systemRandomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }
}
