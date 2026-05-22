import Foundation

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
    private var active: Set<DeviceFingerprint> = []
    private var attempting: Set<DeviceFingerprint> = []
    private var channels: [DeviceFingerprint: SignalingChannel] = [:]
    private var transports: [DeviceFingerprint: MediaTransport] = [:]
    private var iceGraceTimers: [DeviceFingerprint: Task<Void, Never>] = [:]
    private var inputTasks: [DeviceFingerprint: Task<Void, Never>] = [:]

    // Phase transitions
    func noteAttempt(_ fingerprint: DeviceFingerprint) {
        attempting.insert(fingerprint)
    }

    func noteReady(_ session: ActiveSession, channel: SignalingChannel) {
        attempting.remove(session.deviceFingerprint)
        active.insert(session.deviceFingerprint)
        channels[session.deviceFingerprint] = channel
    }

    // Tears down all per-fingerprint state in a defined order: cancel
    // timers and tasks first so their continuations stop touching state,
    // then stop the media transport. The signaling channel is left for
    // the caller to close because closing it fires connectionDidClose,
    // which re-enters here via sessionEndedHandler; doing the close
    // inside would loop.
    func endSession(_ fingerprint: DeviceFingerprint) {
        attempting.remove(fingerprint)
        active.remove(fingerprint)
        channels.removeValue(forKey: fingerprint)
        iceGraceTimers[fingerprint]?.cancel()
        iceGraceTimers.removeValue(forKey: fingerprint)
        inputTasks[fingerprint]?.cancel()
        inputTasks.removeValue(forKey: fingerprint)
        if let transport = transports.removeValue(forKey: fingerprint) {
            transport.stop()
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
}
