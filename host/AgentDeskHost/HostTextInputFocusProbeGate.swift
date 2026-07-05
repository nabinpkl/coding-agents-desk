import AgentDeskWire

struct HostTextInputFocusProbeGate: Equatable {
    private var disabledClients: Set<DeviceFingerprint> = []

    mutating func apply(autoKeyboardEnabled: Bool, for fingerprint: DeviceFingerprint) -> Bool {
        if autoKeyboardEnabled {
            disabledClients.remove(fingerprint)
            return false
        }
        disabledClients.insert(fingerprint)
        return true
    }

    mutating func remove(_ fingerprint: DeviceFingerprint) {
        disabledClients.remove(fingerprint)
    }

    func canScheduleProbe(for fingerprint: DeviceFingerprint) -> Bool {
        !disabledClients.contains(fingerprint)
    }
}
