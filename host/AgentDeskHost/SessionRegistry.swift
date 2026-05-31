import Foundation
import Security

enum InputCapabilityValidationResult: Equatable {
    case accepted(DeviceFingerprint)
    case rejected(SessionRejectionReason)
}

private struct InputCapabilityRecord {
    let sessionId: String
    let inputCapability: String
    let expiresAt: Int
}

private struct InputCapabilityKey: Hashable {
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String
    let inputCapability: String
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
    private var inputChannelServers: [DeviceFingerprint: InputChannelServer] = [:]
    private var inputCapabilities: [DeviceFingerprint: InputCapabilityRecord] = [:]
    private var staleInputCapabilities: Set<InputCapabilityKey> = []

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
        inputCapabilityExpiresAt: Int
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
        priorChannel?.close()
    }

    // Tears down all per-fingerprint state in a defined order: cancel
    // timers and tasks first so their continuations stop touching state,
    // then stop the media transport. The signaling channel is left for
    // the caller to close because closing it fires connectionDidClose,
    // which re-enters here via sessionEndedHandler; doing the close
    // inside would loop.
    func endSession(_ fingerprint: DeviceFingerprint, sessionId: String? = nil) {
        if let sessionId,
           let currentSessionId = sessionIds[fingerprint],
           currentSessionId != sessionId {
            return
        }
        attempting.remove(fingerprint)
        active.remove(fingerprint)
        sessionIds.removeValue(forKey: fingerprint)
        channels.removeValue(forKey: fingerprint)
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
        staleInputCapabilities = Set(staleInputCapabilities.filter { $0.deviceFingerprint != fingerprint })
    }

    func validateInputCapability(_ hello: InputChannelHello) -> InputCapabilityValidationResult {
        let presented = InputCapabilityKey(
            deviceFingerprint: hello.deviceFingerprint,
            sessionId: hello.sessionId,
            inputCapability: hello.inputCapability
        )
        if staleInputCapabilities.contains(presented) {
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
        staleInputCapabilities.insert(presented)
        do {
            inputCapabilities[hello.deviceFingerprint] = try makeCapabilityRecord(sessionId: hello.sessionId)
        } catch {
            return .rejected(.malformed)
        }
        return .accepted(hello.deviceFingerprint)
    }

    func refreshInputCapability(
        deviceFingerprint: DeviceFingerprint,
        sessionId: String
    ) -> Result<InputCapabilityGrant, SessionRejectionReason> {
        guard active.contains(deviceFingerprint),
              sessionIds[deviceFingerprint] == sessionId
        else {
            return .failure(.unauthorized)
        }
        if let current = inputCapabilities[deviceFingerprint] {
            staleInputCapabilities.insert(InputCapabilityKey(
                deviceFingerprint: deviceFingerprint,
                sessionId: current.sessionId,
                inputCapability: current.inputCapability
            ))
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

    func attachInputTask(_ task: Task<Void, Never>, for fingerprint: DeviceFingerprint) {
        inputTasks[fingerprint]?.cancel()
        inputTasks[fingerprint] = task
    }

    // ADR-0005: input channel server has its own NWConnection independent
    // of the WebRTC PeerConnection. Registry owns its close() so session
    // teardown reliably tears it down without each call site having to
    // remember.
    func attachInputChannelServer(_ server: InputChannelServer, for fingerprint: DeviceFingerprint) {
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
    func allInputChannelServers() -> [InputChannelServer] {
        Array(inputChannelServers.values)
    }

    func allInputChannelServersByFingerprint() -> [(DeviceFingerprint, InputChannelServer)] {
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

    nonisolated private static func systemRandomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }
}
