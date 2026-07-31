import Foundation
import Testing
@testable import AgentDeskWire

private let ms = 1_000_000 as UInt64

// MARK: - DatagramArrivalTracker

@Test func aWindowEndingInSilenceReportsTheSilenceAsTheGap() {
    // The bug this exists to prevent: closing the window against the LAST ARRIVAL instead of
    // now makes the first window of a freeze look perfectly healthy, which is precisely the
    // window we need to be honest.
    var tracker = DatagramArrivalTracker()
    tracker.noteArrival(atNs: 0)
    tracker.noteArrival(atNs: 10 * ms)

    let drained = tracker.drain(nowNs: 3_000 * ms)
    #expect(drained.arrivals == 2)
    #expect(drained.maxGapMs == 2_990)
}

@Test func aStallStraddlingTwoWindowsIsStillReported() {
    // lastArrivalNs survives the drain on purpose. If it reset, a freeze that begins in one
    // window and continues into the next would report gap=0 for every window after the first.
    var tracker = DatagramArrivalTracker()
    tracker.noteArrival(atNs: 0)
    _ = tracker.drain(nowNs: 500 * ms)

    let second = tracker.drain(nowNs: 1_000 * ms)
    #expect(second.arrivals == 0)
    #expect(second.maxGapMs == 1_000)
}

@Test func liveLoopWithNoArrivalsIsDistinguishableFromADeadLoop() {
    // The whole point of the counter pair: same zero arrivals, different diagnosis.
    var live = DatagramArrivalTracker()
    for _ in 0..<25 { live.noteLoopIteration() }
    let liveDrain = live.drain(nowNs: 500 * ms)
    #expect(liveDrain.arrivals == 0)
    #expect(liveDrain.loopIterations == 25)

    var dead = DatagramArrivalTracker()
    let deadDrain = dead.drain(nowNs: 500 * ms)
    #expect(deadDrain.arrivals == 0)
    #expect(deadDrain.loopIterations == 0)
}

@Test func drainResetsCountsButNotTheClock() {
    var tracker = DatagramArrivalTracker()
    tracker.noteArrival(atNs: 0)
    tracker.noteLoopIteration()
    _ = tracker.drain(nowNs: 100 * ms)
    #expect(tracker.arrivals == 0)
    #expect(tracker.loopIterations == 0)
}

@Test func outOfOrderTimestampsDoNotUnderflowTheGap() {
    // Uptime clocks are monotonic, but the tracker takes timestamps from callers; an
    // unsigned subtraction on a backwards pair would produce an astronomical gap.
    var tracker = DatagramArrivalTracker()
    tracker.noteArrival(atNs: 100 * ms)
    tracker.noteArrival(atNs: 50 * ms)
    let drained = tracker.drain(nowNs: 60 * ms)
    #expect(drained.arrivals == 2)
    #expect(drained.maxGapMs == 10)
}

// MARK: - wire round trip

@Test func telemetryRoundTripsThroughTheControlMessage() throws {
    let telemetry = OwnedMediaLinkTelemetry(
        interfaceType: "cellular",
        expensive: true,
        constrained: false,
        ultraConstrained: false,
        linkQuality: "moderate",
        pathStatus: "satisfied",
        unsatisfiedReason: nil,
        pathChanges: 2,
        radioAccess: "NRNSA",
        radioChanges: 1,
        datagramsReceived: 0,
        maxArrivalGapMs: 12_790,
        receiveLoopIterations: 25
    )
    let message = OwnedMediaControlMessage(
        kind: .linkHealth,
        frameId: 0,
        linkHealthCompletedFrames: 0,
        linkHealthExpiredFrames: 0,
        linkTelemetry: telemetry
    )

    let data = try JSONEncoder().encode(message)
    let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)

    #expect(decoded.linkTelemetry == telemetry)
    #expect(decoded.linkHealthCompletedFrames == 0)
    #expect(decoded.kind == .linkHealth)
}

@Test func aMessageWithoutTelemetryStaysUnchangedOnTheWire() throws {
    // Every other control message (acks, resend requests, keepalives) must not grow a byte.
    let message = OwnedMediaControlMessage(kind: .frameAck, frameId: 42)
    let data = try JSONEncoder().encode(message)
    let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])

    #expect(json["lt"] == nil)
    let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)
    #expect(decoded.linkTelemetry == nil)
    #expect(decoded.frameId == 42)
}

@Test func absentTelemetryFieldsAreOmittedNotNulled() throws {
    // A host that cannot supply radio data must produce a short message, not one padded with
    // nulls twice a second.
    let telemetry = OwnedMediaLinkTelemetry(interfaceType: "wifi", expensive: false)
    let data = try JSONEncoder().encode(telemetry)
    let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])

    #expect(json.count == 2)
    #expect(json["it"] as? String == "wifi")
    #expect(json["ra"] == nil)
}

@Test func logDescriptionOmitsAbsentFields() {
    let empty = OwnedMediaLinkTelemetry()
    #expect(empty.logDescription == "none")

    let partial = OwnedMediaLinkTelemetry(interfaceType: "cellular", radioAccess: "LTE")
    #expect(partial.logDescription == "iface=cellular radio=LTE")
}
