import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct DomMirrorRelayTests {
    private func d(_ s: String) -> Data { Data(s.utf8) }

    // Records what it received and whether it was closed, so the relay's fan-out and seed-on-attach
    // can be verified without a live QUIC stream.
    final class FakeLane: DomLaneSending, @unchecked Sendable {
        private(set) var sent: [Data] = []
        private(set) var closed = false
        func send(_ payload: Data) { sent.append(payload) }
        func close() { closed = true }
    }

    // ADR-0046: the relay interleaves dom-status frames with batches on the same lane. These helpers
    // split the two so the batch fan-out assertions stay focused on batches.
    private func isStatus(_ data: Data) -> Bool {
        (String(data: data, encoding: .utf8) ?? "").contains("dom-status")
    }
    private func batches(_ lane: FakeLane) -> [Data] { lane.sent.filter { !isStatus($0) } }
    private func statuses(_ lane: FakeLane) -> [DomStatus] {
        lane.sent.filter { isStatus($0) }.compactMap { try? JSONDecoder().decode(DomStatus.self, from: $0) }
    }

    // --- buffer ---

    @Test func bufferKeepsLinesSinceLastCheckout() {
        var b = DomMirrorBuffer()
        b.ingest(line: d("meta+full"), checkout: true)
        b.ingest(line: d("inc1"), checkout: false)
        b.ingest(line: d("inc2"), checkout: false)
        #expect(b.snapshot() == [d("meta+full"), d("inc1"), d("inc2")])
    }

    @Test func checkoutResetsBufferToJustThatBatch() {
        var b = DomMirrorBuffer()
        b.ingest(line: d("old-meta"), checkout: true)
        b.ingest(line: d("old-inc"), checkout: false)
        b.ingest(line: d("new-meta"), checkout: true)
        #expect(b.snapshot() == [d("new-meta")])
    }

    @Test func bufferCapDropsOldest() {
        var b = DomMirrorBuffer(cap: 3)
        b.ingest(line: d("c"), checkout: true)
        b.ingest(line: d("1"), checkout: false)
        b.ingest(line: d("2"), checkout: false)
        b.ingest(line: d("3"), checkout: false) // 4 lines > cap 3 -> drop oldest ("c")
        #expect(b.snapshot() == [d("1"), d("2"), d("3")])
    }

    // --- relay fan-out + seed ---

    @Test func liveBatchFansToAttachedLane() {
        let relay = DomMirrorRelay()
        let lane = FakeLane()
        relay.attach(lane, for: DeviceFingerprint("fp1"))
        relay.ingest(line: d("live1"), tabId: 1, checkout: true)
        relay.ingest(line: d("live2"), tabId: 1, checkout: false)
        #expect(batches(lane) == [d("live1"), d("live2")])
    }

    @Test func lateAttachSeedsFromCheckoutBufferInOrderThenGoesLive() {
        let relay = DomMirrorRelay()
        // Batches arrive before any lane attaches.
        relay.ingest(line: d("meta"), tabId: 1, checkout: true)
        relay.ingest(line: d("inc1"), tabId: 1, checkout: false)
        relay.ingest(line: d("inc2"), tabId: 1, checkout: false)
        let lane = FakeLane()
        relay.attach(lane, for: DeviceFingerprint("fp1")) // late join -> seeded with the buffer
        #expect(batches(lane) == [d("meta"), d("inc1"), d("inc2")])
        relay.ingest(line: d("inc3"), tabId: 1, checkout: false) // then live
        #expect(batches(lane) == [d("meta"), d("inc1"), d("inc2"), d("inc3")])
    }

    @Test func attachingNewLaneClosesPriorForSameFingerprint() {
        let relay = DomMirrorRelay()
        let fp = DeviceFingerprint("fp1")
        let first = FakeLane()
        let second = FakeLane()
        relay.attach(first, for: fp)
        relay.attach(second, for: fp)
        #expect(first.closed)
        #expect(!second.closed)
    }

    @Test func detachClosesAndStopsFanning() {
        let relay = DomMirrorRelay()
        let fp = DeviceFingerprint("fp1")
        let lane = FakeLane()
        relay.attach(lane, for: fp)
        relay.detach(for: fp)
        #expect(lane.closed)
        relay.ingest(line: d("after"), tabId: 1, checkout: true)
        #expect(batches(lane).isEmpty) // no batches after detach
    }

    // --- ADR-0046 diagnostic status fan-out ---

    @Test func attachPushesInitialStatus() {
        let relay = DomMirrorRelay()
        let lane = FakeLane()
        relay.attach(lane, for: DeviceFingerprint("fp1"))
        // ext defaults false, no recording tab yet, not emulated.
        #expect(statuses(lane).last == DomStatus(ext: false, tab: nil, emulated: false))
    }

    @Test func extConnectAndDisconnectPushStatus() {
        let relay = DomMirrorRelay()
        let lane = FakeLane()
        relay.attach(lane, for: DeviceFingerprint("fp1"))
        relay.setExtConnected(true)
        #expect(statuses(lane).last == DomStatus(ext: true, tab: nil, emulated: false))
        relay.setExtConnected(false)
        #expect(statuses(lane).last == DomStatus(ext: false, tab: nil, emulated: false))
    }

    @Test func ingestMarksReachableAndRecordingTab() {
        let relay = DomMirrorRelay()
        let lane = FakeLane()
        relay.attach(lane, for: DeviceFingerprint("fp1"))
        relay.ingest(line: d("b"), tabId: 7, checkout: true) // batches only flow while recording
        #expect(statuses(lane).last == DomStatus(ext: true, tab: 7, emulated: false))
    }

    @Test func extDisconnectClearsRecordingTab() {
        let relay = DomMirrorRelay()
        let lane = FakeLane()
        relay.attach(lane, for: DeviceFingerprint("fp1"))
        relay.ingest(line: d("b"), tabId: 7, checkout: true)
        relay.setExtConnected(false)
        #expect(statuses(lane).last == DomStatus(ext: false, tab: nil, emulated: false))
    }

    // ADR-0048: a batch's `em` stamp updates the fanned emulation state; a nil `em` leaves it, and a
    // disconnect resets it to desktop. This is the authoritative-echo path the client's toggle tracks.
    @Test func batchEmStampFansEmulationState() {
        let relay = DomMirrorRelay()
        let lane = FakeLane()
        relay.attach(lane, for: DeviceFingerprint("fp1"))
        relay.ingest(line: d("b1"), tabId: 3, checkout: true, emulated: true)
        #expect(statuses(lane).last?.emulated == true)
        // A batch without an em stamp leaves the last-known emulation state untouched.
        relay.ingest(line: d("b2"), tabId: 3, checkout: false, emulated: nil)
        #expect(statuses(lane).last?.emulated == true)
        relay.ingest(line: d("b3"), tabId: 3, checkout: false, emulated: false)
        #expect(statuses(lane).last?.emulated == false)
        // A disconnect resets emulation to desktop (state no longer known).
        relay.ingest(line: d("b4"), tabId: 3, checkout: false, emulated: true)
        relay.setExtConnected(false)
        #expect(statuses(lane).last?.emulated == false)
    }

    @Test func domStatusEnvelopeEncodesTabAndOmitsNil() throws {
        let withTab = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(DomStatus(ext: true, tab: 3, emulated: true))) as? [String: Any]
        #expect(withTab?["t"] as? String == "dom-status")
        #expect(withTab?["ext"] as? Bool == true)
        #expect(withTab?["tab"] as? Int == 3)
        #expect(withTab?["emulated"] as? Bool == true) // ADR-0048: emulated present on the wire

        let noTab = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(DomStatus(ext: false, tab: nil))) as? [String: Any]
        #expect(noTab?.keys.contains("tab") == false) // nil optional omitted from the wire
    }
}
