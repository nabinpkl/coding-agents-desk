import Foundation
import os

// ADR-0038 late-join buffer for the DOM lane: the raw rrweb batch lines since (and including) the
// most recent checkout batch (the one carrying a fresh Meta + FullSnapshot). A phone that opens the
// lane late is seeded with this buffer so it reaches a coherent frame before going live -- the
// host-side analog of the spike relay's bufferEvent(). Pure and socket-free for unit testing.
struct DomMirrorBuffer {
    private(set) var lines: [Data] = []
    private let cap: Int

    init(cap: Int = 4000) { self.cap = cap }

    mutating func ingest(line: Data, checkout: Bool) {
        if checkout {
            // A checkout batch opens a fresh snapshot; drop everything before it.
            lines = [line]
        } else {
            lines.append(line)
            if lines.count > cap { lines.removeFirst(lines.count - cap) }
        }
    }

    func snapshot() -> [Data] { lines }
}

// A destination for framed DOM batches. DomEventLaneServer conforms; tests inject a fake so the
// relay's fan-out and seed-on-attach can be verified without a live QUIC stream. Sendable so the
// relay can hold lanes inside its OSAllocatedUnfairLock and call them across threads (both the
// lane server and the test fake are already @unchecked Sendable / thread-safe).
protocol DomLaneSending: AnyObject, Sendable {
    func send(_ payload: Data)
    func close()
}

// Fans DOM batches from the single Chrome source to the attached client lane(s) and holds the
// late-join buffer, so a freshly-attached lane is seeded to a coherent frame before live batches.
// Fed from the DomBridgeServer queue; guards its state with a lock so it is callable from any thread.
final class DomMirrorRelay: @unchecked Sendable {
    private struct State { var buffer: DomMirrorBuffer; var lanes: [DeviceFingerprint: DomLaneSending] }
    private let lock: OSAllocatedUnfairLock<State>

    init(bufferCap: Int = 4000) {
        lock = OSAllocatedUnfairLock(initialState: State(buffer: DomMirrorBuffer(cap: bufferCap), lanes: [:]))
    }

    // A new DOM batch from Chrome: buffer it, then fan it to every attached lane. The lane's own
    // send is thread-safe and ordered, so we call it outside the lock.
    func ingest(line: Data, checkout: Bool) {
        let lanes: [DomLaneSending] = lock.withLock { state in
            state.buffer.ingest(line: line, checkout: checkout)
            return Array(state.lanes.values)
        }
        // A lane whose stream died without a session-end stays in the map until the next attach or
        // session-end; its send() enqueues a Task that fails at stream.send and logs -- benign, and
        // identical to the shipping graphics lane. One lane per fingerprint (replaced via attach,
        // never accumulated), so no unbounded growth.
        for lane in lanes { lane.send(line) }
    }

    // A phone opened the .dom lane: replace any prior lane for that fingerprint, then seed the new
    // lane with the buffered checkout so it bootstraps before live batches arrive.
    func attach(_ lane: DomLaneSending, for fingerprint: DeviceFingerprint) {
        let (prior, seed): (DomLaneSending?, [Data]) = lock.withLock { state in
            let prior = state.lanes[fingerprint]
            state.lanes[fingerprint] = lane
            return (prior, state.buffer.snapshot())
        }
        prior?.close()
        for line in seed { lane.send(line) }
    }

    func detach(for fingerprint: DeviceFingerprint) {
        let lane: DomLaneSending? = lock.withLock { state in
            let l = state.lanes[fingerprint]
            state.lanes[fingerprint] = nil
            return l
        }
        lane?.close()
    }
}

@available(macOS 26.0, *)
extension DomEventLaneServer: DomLaneSending {}
