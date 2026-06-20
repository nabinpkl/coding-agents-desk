import Foundation
import Security

enum InputCapabilityValidationResult: Equatable {
    case accepted(DeviceFingerprint)
    case rejected(SessionRejectionReason)
}

enum MediaCapabilityValidationResult: Equatable {
    case accepted(DeviceFingerprint)
    case rejected(SessionRejectionReason)
}

private struct InputCapabilityRecord {
    let sessionId: String
    let inputCapability: String
    let expiresAt: Int
}

private struct MediaCapabilityRecord {
    let sessionId: String
    let mediaCapability: String
    let expiresAt: Int
}

private struct InputCapabilityKey: Hashable {
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String
    let inputCapability: String
}

private struct MediaCapabilityKey: Hashable {
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String
    let mediaCapability: String
}

private struct StaleInputCapabilityRecord {
    let expiresAt: Int
}

private struct StaleMediaCapabilityRecord {
    let expiresAt: Int
}

private struct StaleGraphicsCapabilityRecord {
    let expiresAt: Int
}

// Per-fingerprint state for in-flight and active host sessions. Lives
// outside AppDelegate so the bookkeeping (which dictionary entries belong
// to which lifecycle phase, what the teardown order is) sits in one
// inspectable type instead of being smeared across handler methods.
//
// MainActor-isolated because every call site is already on MainActor
// (signaling callbacks hop here via Task { @MainActor in }) and the
// underlying state has no thread-safety story of its own.
@MainActor
final class SessionRegistry {
    private let now: () -> Date
    private let randomBytes: (Int) throws -> Data
    private var active: Set<DeviceFingerprint> = []
    private var attempting: Set<DeviceFingerprint> = []
    private var sessionIds: [DeviceFingerprint: String] = [:]
    private var channels: [DeviceFingerprint: SignalingChannel] = [:]
    private var transports: [DeviceFingerprint: MediaTransport] = [:]
    private var iceGraceTimers: [DeviceFingerprint: Task<Void, Never>] = [:]
    private var inputTasks: [DeviceFingerprint: Task<Void, Never>] = [:]
    private var inputChannelServers: [DeviceFingerprint: any InputChannelServing] = [:]
    private var inputCapabilities: [DeviceFingerprint: InputCapabilityRecord] = [:]
    private var staleInputCapabilities: [InputCapabilityKey: StaleInputCapabilityRecord] = [:]
    private var mediaCapabilities: [DeviceFingerprint: MediaCapabilityRecord] = [:]
    private var staleMediaCapabilities: [MediaCapabilityKey: StaleMediaCapabilityRecord] = [:]
    private var staleGraphicsCapabilities: [MediaCapabilityKey: StaleGraphicsCapabilityRecord] = [:]

    init(
        now: @escaping () -> Date = Date.init,
        randomBytes: @escaping (Int) throws -> Data = SessionRegistry.systemRandomBytes
    ) {
        self.now = now
        self.randomBytes = randomBytes
    }

    // Phase transitions
    func noteAttempt(_ fingerprint: DeviceFingerprint) {
        attempting.insert(fingerprint)
    }

    func noteReady(
        _ session: ActiveSession,
        channel: SignalingChannel,
        inputCapability: String,
        inputCapabilityExpiresAt: Int,
        mediaCapability: String = "",
        mediaCapabilityExpiresAt: Int = 0
    ) {
        var priorChannel: SignalingChannel?
        if let priorSessionId = sessionIds[session.deviceFingerprint],
           priorSessionId != session.sessionId {
            priorChannel = channels[session.deviceFingerprint]
            endSession(session.deviceFingerprint, sessionId: priorSessionId)
        }
        attempting.remove(session.deviceFingerprint)
        active.insert(session.deviceFingerprint)
        sessionIds[session.deviceFingerprint] = session.sessionId
        channels[session.deviceFingerprint] = channel
        inputCapabilities[session.deviceFingerprint] = InputCapabilityRecord(
            sessionId: session.sessionId,
            inputCapability: inputCapability,
            expiresAt: inputCapabilityExpiresAt
        )
        mediaCapabilities[session.deviceFingerprint] = MediaCapabilityRecord(
            sessionId: session.sessionId,
            mediaCapability: mediaCapability,
            expiresAt: mediaCapabilityExpiresAt
        )
        priorChannel?.close()
    }

    // Tears down all per-fingerprint state in a defined order: cancel
    // timers and tasks first so their continuations stop touching state,
    // then stop the media transport. Normal connection-close paths leave
    // the signaling channel for the caller, because closing it fires
    // connectionDidClose and re-enters here. Revocation passes
    // closeSignaling=true after the allowlist row is deleted.
    func endSession(_ fingerprint: DeviceFingerprint, sessionId: String? = nil, closeSignaling: Bool = false) {
        if let sessionId,
           let currentSessionId = sessionIds[fingerprint],
           currentSessionId != sessionId {
            return
        }
        let channel = channels.removeValue(forKey: fingerprint)
        attempting.remove(fingerprint)
        active.remove(fingerprint)
        sessionIds.removeValue(forKey: fingerprint)
        iceGraceTimers[fingerprint]?.cancel()
        iceGraceTimers.removeValue(forKey: fingerprint)
        inputTasks[fingerprint]?.cancel()
        inputTasks.removeValue(forKey: fingerprint)
        inputChannelServers[fingerprint]?.close()
        inputChannelServers.removeValue(forKey: fingerprint)
        if let transport = transports.removeValue(forKey: fingerprint) {
            transport.stop()
        }
        inputCapabilities.removeValue(forKey: fingerprint)
        staleInputCapabilities = staleInputCapabilities.filter { $0.key.deviceFingerprint != fingerprint }
        mediaCapabilities.removeValue(forKey: fingerprint)
        staleMediaCapabilities = staleMediaCapabilities.filter { $0.key.deviceFingerprint != fingerprint }
        staleGraphicsCapabilities = staleGraphicsCapabilities.filter { $0.key.deviceFingerprint != fingerprint }
        if closeSignaling {
            channel?.close()
        }
    }

    func validateInputCapability(_ hello: InputChannelHello) -> InputCapabilityValidationResult {
        pruneExpiredStaleInputCapabilities()
        let presented = InputCapabilityKey(
            deviceFingerprint: hello.deviceFingerprint,
            sessionId: hello.sessionId,
            inputCapability: hello.inputCapability
        )
        if staleInputCapabilities[presented] != nil {
            return .rejected(.staleInputCapability)
        }
        guard active.contains(hello.deviceFingerprint),
              sessionIds[hello.deviceFingerprint] == hello.sessionId,
              let current = inputCapabilities[hello.deviceFingerprint],
              current.sessionId == hello.sessionId
        else {
            return .rejected(.unauthorized)
        }
        guard current.inputCapability == hello.inputCapability else {
            return .rejected(.unauthorized)
        }
        guard Int(now().timeIntervalSince1970) <= current.expiresAt else {
            return .rejected(.expiredInputCapability)
        }
        markStaleInputCapability(presented, originalExpiresAt: current.expiresAt)
        do {
            inputCapabilities[hello.deviceFingerprint] = try makeCapabilityRecord(sessionId: hello.sessionId)
        } catch {
            return .rejected(.malformed)
        }
        return .accepted(hello.deviceFingerprint)
    }

    func validateMediaCapability(_ hello: MediaChannelHello) -> MediaCapabilityValidationResult {
        pruneExpiredStaleMediaCapabilities()
        let presented = MediaCapabilityKey(
            deviceFingerprint: hello.deviceFingerprint,
            sessionId: hello.sessionId,
            mediaCapability: hello.mediaCapability
        )
        if staleMediaCapabilities[presented] != nil {
            return .rejected(.staleMediaCapability)
        }
        guard active.contains(hello.deviceFingerprint),
              sessionIds[hello.deviceFingerprint] == hello.sessionId,
              let current = mediaCapabilities[hello.deviceFingerprint],
              current.sessionId == hello.sessionId
        else {
            return .rejected(.unauthorized)
        }
        guard current.mediaCapability == hello.mediaCapability else {
            return .rejected(.unauthorized)
        }
        guard Int(now().timeIntervalSince1970) <= current.expiresAt else {
            return .rejected(.expiredMediaCapability)
        }
        markStaleMediaCapability(presented, originalExpiresAt: current.expiresAt)
        return .accepted(hello.deviceFingerprint)
    }

    func validateGraphicsCapability(_ hello: GraphicsChannelHello) -> MediaCapabilityValidationResult {
        pruneExpiredStaleGraphicsCapabilities()
        let presented = MediaCapabilityKey(
            deviceFingerprint: hello.deviceFingerprint,
            sessionId: hello.sessionId,
            mediaCapability: hello.graphicsCapability
        )
        if staleGraphicsCapabilities[presented] != nil {
            return .rejected(.staleMediaCapability)
        }
        guard active.contains(hello.deviceFingerprint),
              sessionIds[hello.deviceFingerprint] == hello.sessionId,
              let current = mediaCapabilities[hello.deviceFingerprint],
              current.sessionId == hello.sessionId
        else {
            return .rejected(.unauthorized)
        }
        guard current.mediaCapability == hello.graphicsCapability else {
            return .rejected(.unauthorized)
        }
        guard Int(now().timeIntervalSince1970) <= current.expiresAt else {
            return .rejected(.expiredMediaCapability)
        }
        markStaleGraphicsCapability(presented, originalExpiresAt: current.expiresAt)
        return .accepted(hello.deviceFingerprint)
    }

    func refreshInputCapability(
        deviceFingerprint: DeviceFingerprint,
        sessionId: String
    ) -> Result<InputCapabilityGrant, SessionRejectionReason> {
        pruneExpiredStaleInputCapabilities()
        guard active.contains(deviceFingerprint),
              sessionIds[deviceFingerprint] == sessionId
        else {
            return .failure(.unauthorized)
        }
        if let current = inputCapabilities[deviceFingerprint] {
            markStaleInputCapability(
                InputCapabilityKey(
                    deviceFingerprint: deviceFingerprint,
                    sessionId: current.sessionId,
                    inputCapability: current.inputCapability
                ),
                originalExpiresAt: current.expiresAt
            )
        }
        do {
            let record = try makeCapabilityRecord(sessionId: sessionId)
            inputCapabilities[deviceFingerprint] = record
            return .success(InputCapabilityGrant(
                sessionId: sessionId,
                inputCapability: record.inputCapability,
                inputCapabilityExpiresAt: record.expiresAt
            ))
        } catch {
            return .failure(.malformed)
        }
    }

    // Attachments
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

    // ADR-0005: input channel server has its own NWConnection independent
    // of the media channel. Registry owns its close() so session
    // teardown reliably tears it down without each call site having to
    // remember.
    func attachInputChannelServer(_ server: any InputChannelServing, for fingerprint: DeviceFingerprint) {
        inputChannelServers[fingerprint]?.close()
        inputChannelServers[fingerprint] = server
    }

    func scheduleIceGrace(_ task: Task<Void, Never>, for fingerprint: DeviceFingerprint) {
        iceGraceTimers[fingerprint]?.cancel()
        iceGraceTimers[fingerprint] = task
    }

    func cancelIceGrace(for fingerprint: DeviceFingerprint) {
        iceGraceTimers[fingerprint]?.cancel()
        iceGraceTimers.removeValue(forKey: fingerprint)
    }

    // Reads
    func isActive(_ fingerprint: DeviceFingerprint) -> Bool {
        active.contains(fingerprint)
    }

    func isAttempting(_ fingerprint: DeviceFingerprint) -> Bool {
        attempting.contains(fingerprint)
    }

    func signalingChannel(for fingerprint: DeviceFingerprint) -> SignalingChannel? {
        channels[fingerprint]
    }

    // R11: AppDelegate's switchSpaceHandler needs to push the new
    // DesktopState after each successful Spaces switch. The handler
    // captures the registry weakly and walks every active input
    // channel server to push (v0 has at most one; v1 may grow to
    // multiple paired clients).
    func allInputChannelServers() -> [any InputChannelServing] {
        Array(inputChannelServers.values)
    }

    func allInputChannelServersByFingerprint() -> [(DeviceFingerprint, any InputChannelServing)] {
        inputChannelServers.map { ($0.key, $0.value) }
    }

    private func makeCapabilityRecord(sessionId: String) throws -> InputCapabilityRecord {
        let issuedAt = now()
        return InputCapabilityRecord(
            sessionId: sessionId,
            inputCapability: try randomBytes(32).base64URLEncodedString(),
            expiresAt: Int(issuedAt.addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        )
    }

    private func markStaleInputCapability(_ key: InputCapabilityKey, originalExpiresAt: Int) {
        let ttlExpiresAt = Int(now().addingTimeInterval(Config.inputCapabilityTTL).timeIntervalSince1970)
        staleInputCapabilities[key] = StaleInputCapabilityRecord(
            expiresAt: min(originalExpiresAt, ttlExpiresAt)
        )
    }

    private func markStaleMediaCapability(_ key: MediaCapabilityKey, originalExpiresAt: Int) {
        let ttlExpiresAt = Int(now().addingTimeInterval(Config.mediaCapabilityTTL).timeIntervalSince1970)
        staleMediaCapabilities[key] = StaleMediaCapabilityRecord(
            expiresAt: min(originalExpiresAt, ttlExpiresAt)
        )
    }

    private func markStaleGraphicsCapability(_ key: MediaCapabilityKey, originalExpiresAt: Int) {
        let ttlExpiresAt = Int(now().addingTimeInterval(Config.mediaCapabilityTTL).timeIntervalSince1970)
        staleGraphicsCapabilities[key] = StaleGraphicsCapabilityRecord(
            expiresAt: min(originalExpiresAt, ttlExpiresAt)
        )
    }

    private func pruneExpiredStaleInputCapabilities() {
        let currentTime = Int(now().timeIntervalSince1970)
        staleInputCapabilities = staleInputCapabilities.filter { $0.value.expiresAt >= currentTime }
    }

    private func pruneExpiredStaleMediaCapabilities() {
        let currentTime = Int(now().timeIntervalSince1970)
        staleMediaCapabilities = staleMediaCapabilities.filter { $0.value.expiresAt >= currentTime }
    }

    private func pruneExpiredStaleGraphicsCapabilities() {
        let currentTime = Int(now().timeIntervalSince1970)
        staleGraphicsCapabilities = staleGraphicsCapabilities.filter { $0.value.expiresAt >= currentTime }
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
