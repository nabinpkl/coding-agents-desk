import Foundation
import os
import AgentDeskWire

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
    private struct State {
        var buffer: DomMirrorBuffer
        var lanes: [DeviceFingerprint: DomLaneSending]
        var localProjection: DomLaneSending?
        // ADR-0046 diagnostic status pushed to the client's Browser status line.
        var extConnected: Bool
        var lastTabId: Int?
        // ADR-0048: authoritative device-emulation state, read off each batch's `em` stamp.
        var emulated: Bool
    }
    private let lock: OSAllocatedUnfairLock<State>

    init(bufferCap: Int = 4000) {
        lock = OSAllocatedUnfairLock(initialState: State(
            buffer: DomMirrorBuffer(cap: bufferCap), lanes: [:], localProjection: nil,
            extConnected: false, lastTabId: nil,
            emulated: false))
    }

    // ADR-0046: encode the current status as one .dom-lane frame. Called inside the lock so ext/tab/
    // emulated are read atomically with the lane set they will be sent to.
    private func statusFrameLocked(_ state: State) -> Data? {
        try? JSONEncoder().encode(DomStatus(
            ext: state.extConnected, tab: state.lastTabId, emulated: state.emulated))
    }

    // A new DOM batch from Chrome: buffer it, then fan it to every attached lane. The lane's own
    // send is thread-safe and ordered, so we call it outside the lock. `emulated` is the batch's `em`
    // stamp (ADR-0048): nil leaves the state untouched, a value updates it and re-pushes status on a
    // change so the client's Desktop|Mobile control tracks the authoritative host state.
    func ingest(line: Data, tabId: Int, checkout: Bool, emulated: Bool? = nil) {
        let (lanes, statusFrame): ([DomLaneSending], Data?) = lock.withLock { state in
            state.buffer.ingest(line: line, checkout: checkout)
            // Batches only flow while a tab is recording, so a batch means the extension is reachable.
            var changed = state.lastTabId != tabId || !state.extConnected
            if let emulated, state.emulated != emulated { state.emulated = emulated; changed = true }
            state.extConnected = true
            state.lastTabId = tabId
            let destinations = Array(state.lanes.values) + [state.localProjection].compactMap { $0 }
            return (destinations, changed ? statusFrameLocked(state) : nil)
        }
        // A lane whose stream died without a session-end stays in the map until the next attach or
        // session-end; its send() enqueues a Task that fails at stream.send and logs -- benign, and
        // identical to the shipping graphics lane. One lane per fingerprint (replaced via attach,
        // never accumulated), so no unbounded growth.
        for lane in lanes { lane.send(line) }
        if let statusFrame { for lane in lanes { lane.send(statusFrame) } }
    }

    // ADR-0046: the native-messaging bridge to the Chrome extension connected/disconnected. Push the
    // fresh reachability to every attached lane. A disconnect also means nothing is recording.
    func setExtConnected(_ connected: Bool) {
        let (lanes, statusFrame): ([DomLaneSending], Data?) = lock.withLock { state in
            state.extConnected = connected
            // ADR-0048: a disconnect means nothing is recording and the emulation state is no longer
            // known; reset to desktop so the client shows a truthful default until a batch's `em` stamp
            // re-establishes it on reconnect.
            if !connected { state.lastTabId = nil; state.emulated = false }
            let destinations = Array(state.lanes.values) + [state.localProjection].compactMap { $0 }
            return (destinations, statusFrameLocked(state))
        }
        if let statusFrame { for lane in lanes { lane.send(statusFrame) } }
    }

    // A phone opened the .dom lane: replace any prior lane for that fingerprint, then seed the new
    // lane with the buffered checkout so it bootstraps before live batches arrive.
    func attach(_ lane: DomLaneSending, for fingerprint: DeviceFingerprint) {
        let (prior, seed, statusFrame): (DomLaneSending?, [Data], Data?) = lock.withLock { state in
            let prior = state.lanes[fingerprint]
            state.lanes[fingerprint] = lane
            return (prior, state.buffer.snapshot(), statusFrameLocked(state))
        }
        prior?.close()
        for line in seed { lane.send(line) }
        // Send the current diagnostic status so a freshly-opened Browser lane immediately shows
        // whether the extension is reachable, even before any batch arrives.
        if let statusFrame { lane.send(statusFrame) }
    }

    func detach(for fingerprint: DeviceFingerprint) {
        let lane: DomLaneSending? = lock.withLock { state in
            let l = state.lanes[fingerprint]
            state.lanes[fingerprint] = nil
            return l
        }
        lane?.close()
    }

    // The host-local Browser Projection uses the same checkout buffer as a remote lane but bypasses
    // QUIC. One retained local destination is enough because the host owns one Browser window.
    func attachLocalProjection(_ projection: DomLaneSending) {
        let (prior, seed, statusFrame): (DomLaneSending?, [Data], Data?) = lock.withLock { state in
            let prior = state.localProjection
            state.localProjection = projection
            return (prior, state.buffer.snapshot(), statusFrameLocked(state))
        }
        prior?.close()
        for line in seed { projection.send(line) }
        if let statusFrame { projection.send(statusFrame) }
    }

    func detachLocalProjection() {
        let projection = lock.withLock { state in
            let current = state.localProjection
            state.localProjection = nil
            return current
        }
        projection?.close()
    }
}

@available(macOS 26.0, *)
extension DomEventLaneServer: DomLaneSending {}
