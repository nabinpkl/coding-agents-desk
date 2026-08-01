import Foundation
import Testing

@testable import AgentDeskWire

/// Redialing on the link-change edge bound the new connection to the interface that was on its
/// way out: the dial came up, sent its resume init, and read zero bytes back. Four of every six
/// seconds of handover outage were spent inside that doomed attempt.
///
/// What is pinned here is the distinction that makes the gate work -- "usable" is not the same
/// as "holding still", and a path mid-handover reports the interface it is about to drop as
/// perfectly satisfied.
struct NetworkPathSettleGateTests {

    private func snapshot(
        interface: String = "wifi",
        status: String = "satisfied",
        linkQuality: String = "good"
    ) -> LinkPathSnapshot {
        LinkPathSnapshot(
            interfaceType: interface,
            expensive: false,
            constrained: false,
            ultraConstrained: false,
            linkQuality: linkQuality,
            status: status,
            unsatisfiedReason: nil
        )
    }

    @Test func aPathIsNotSettledUntilTheWindowHasElapsed() {
        var gate = NetworkPathSettleGate(debounceMs: 400)
        gate.observe(snapshot(interface: "cellular"), atMs: 1_000)

        #expect(!gate.hasSettled(atMs: 1_000))
        #expect(!gate.hasSettled(atMs: 1_399))
        #expect(gate.hasSettled(atMs: 1_400))
    }

    // The reason the gate exists. A phone leaving WiFi reports the dying interface as
    // satisfied, so a check for usability alone passes at exactly the wrong moment.
    @Test func aSatisfiedPathThatKeepsChangingNeverSettles() {
        var gate = NetworkPathSettleGate(debounceMs: 400)
        gate.observe(snapshot(interface: "wifi"), atMs: 0)
        #expect(gate.hasSettled(atMs: 500))

        // Mid-handover: still satisfied at every step, but never the same twice.
        gate.observe(snapshot(interface: "cellular", linkQuality: "minimal"), atMs: 600)
        #expect(!gate.hasSettled(atMs: 800))
        gate.observe(snapshot(interface: "wifi"), atMs: 900)
        #expect(!gate.hasSettled(atMs: 1_100))
        gate.observe(snapshot(interface: "cellular", linkQuality: "minimal"), atMs: 1_200)
        #expect(!gate.hasSettled(atMs: 1_500))

        // Once it stops moving, the window runs to completion.
        #expect(gate.hasSettled(atMs: 1_600))
    }

    @Test func anUnsatisfiedPathNeverSettlesHoweverLongItHolds() {
        var gate = NetworkPathSettleGate(debounceMs: 400)
        gate.observe(snapshot(status: "unsatisfied"), atMs: 0)

        #expect(!gate.hasSettled(atMs: 10_000))
    }

    // Having observed nothing is not evidence the path is calm. The caller bounds its own wait
    // rather than relying on the gate to eventually relent.
    @Test func anUnobservedPathIsNotSettled() {
        let gate = NetworkPathSettleGate(debounceMs: 400)
        #expect(!gate.hasSettled(atMs: 10_000))
    }

    // Monitor callbacks fire for changes the snapshot does not model. Treating a repeat as a
    // change would restart the window on noise and hold every redial to the timeout.
    @Test func repeatingTheSameSnapshotDoesNotRestartTheWindow() {
        var gate = NetworkPathSettleGate(debounceMs: 400)
        gate.observe(snapshot(interface: "cellular"), atMs: 0)
        gate.observe(snapshot(interface: "cellular"), atMs: 100)
        gate.observe(snapshot(interface: "cellular"), atMs: 300)

        #expect(gate.hasSettled(atMs: 400))
    }

    @Test func aZeroWindowSettlesAsSoonAsThePathIsUsable() {
        var gate = NetworkPathSettleGate(debounceMs: 0)
        gate.observe(snapshot(interface: "cellular"), atMs: 500)

        #expect(gate.hasSettled(atMs: 500))
    }
}
