import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct HostTextInputFocusProbeGateTests {
    @Test func defaultAllowsProbeScheduling() {
        let gate = HostTextInputFocusProbeGate()
        #expect(gate.canScheduleProbe(for: DeviceFingerprint("device-a")))
    }

    @Test func disablingAutoKeyboardBlocksSchedulingAndRequestsCancellation() {
        var gate = HostTextInputFocusProbeGate()
        let fingerprint = DeviceFingerprint("device-a")

        let shouldCancel = gate.apply(autoKeyboardEnabled: false, for: fingerprint)

        #expect(shouldCancel)
        #expect(gate.canScheduleProbe(for: fingerprint) == false)
    }

    @Test func enablingAutoKeyboardAllowsSchedulingWithoutCancellation() {
        var gate = HostTextInputFocusProbeGate()
        let fingerprint = DeviceFingerprint("device-a")
        _ = gate.apply(autoKeyboardEnabled: false, for: fingerprint)

        let shouldCancel = gate.apply(autoKeyboardEnabled: true, for: fingerprint)

        #expect(shouldCancel == false)
        #expect(gate.canScheduleProbe(for: fingerprint))
    }

    @Test func removingClientClearsDisabledState() {
        var gate = HostTextInputFocusProbeGate()
        let fingerprint = DeviceFingerprint("device-a")
        _ = gate.apply(autoKeyboardEnabled: false, for: fingerprint)

        gate.remove(fingerprint)

        #expect(gate.canScheduleProbe(for: fingerprint))
    }
}
