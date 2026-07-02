import Foundation
import Testing

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
        relay.ingest(line: d("live1"), checkout: true)
        relay.ingest(line: d("live2"), checkout: false)
        #expect(lane.sent == [d("live1"), d("live2")])
    }

    @Test func lateAttachSeedsFromCheckoutBufferInOrderThenGoesLive() {
        let relay = DomMirrorRelay()
        // Batches arrive before any lane attaches.
        relay.ingest(line: d("meta"), checkout: true)
        relay.ingest(line: d("inc1"), checkout: false)
        relay.ingest(line: d("inc2"), checkout: false)
        let lane = FakeLane()
        relay.attach(lane, for: DeviceFingerprint("fp1")) // late join -> seeded with the buffer
        #expect(lane.sent == [d("meta"), d("inc1"), d("inc2")])
        relay.ingest(line: d("inc3"), checkout: false) // then live
        #expect(lane.sent == [d("meta"), d("inc1"), d("inc2"), d("inc3")])
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
        relay.ingest(line: d("after"), checkout: true)
        #expect(lane.sent.isEmpty) // nothing sent after detach
    }
}
