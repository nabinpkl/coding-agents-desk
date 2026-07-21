import Foundation
import os
import AgentDeskWire
import BrowserProjection

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

// Fans projection metadata and DOM batches from the single Chrome source to attached client lanes.
// It retains the latest browser snapshot and a late-join page buffer so a fresh lane receives a
// coherent shell and page before live updates. Fed from the DomBridgeServer queue; guards its state
// with a lock so it is callable from any thread.
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
        var hostSHA: String
        var browserState: Data?
    }
    private let lock: OSAllocatedUnfairLock<State>

    init(bufferCap: Int = 4000) {
        lock = OSAllocatedUnfairLock(initialState: State(
            buffer: DomMirrorBuffer(cap: bufferCap), lanes: [:], localProjection: nil,
            extConnected: false, lastTabId: nil,
            emulated: false, hostSHA: "dev", browserState: nil))
    }

    // ADR-0046: encode the current status as one .dom-lane frame. Called inside the lock so ext/tab/
    // emulated are read atomically with the lane set they will be sent to.
    private func statusFrameLocked(_ state: State) -> Data? {
        try? JSONEncoder().encode(DomStatus(
            ext: state.extConnected, tab: state.lastTabId, emulated: state.emulated))
    }

    private func hostStateFrameLocked(_ state: State) -> Data? {
        try? JSONEncoder().encode(BrowserProjectionHostState(
            connected: state.extConnected,
            sha: state.hostSHA
        ))
    }

    func setHostSHA(_ sha: String) {
        let (lanes, hostState): ([DomLaneSending], Data?) = lock.withLock { state in
            state.hostSHA = sha
            return (Array(state.lanes.values), hostStateFrameLocked(state))
        }
        if let hostState { for lane in lanes { lane.send(hostState) } }
    }

    func ingestBrowserState(_ payload: Data) {
        let lanes: [DomLaneSending] = lock.withLock { state in
            state.browserState = payload
            return Array(state.lanes.values)
        }
        for lane in lanes { lane.send(payload) }
    }

    // A new DOM batch from Chrome: buffer it, then fan it to every attached lane. The lane's own
    // send is thread-safe and ordered, so we call it outside the lock. `emulated` is the batch's `em`
    // stamp (ADR-0048): nil leaves the state untouched, a value updates it and re-pushes status on a
    // change so the client's Desktop|Mobile control tracks the authoritative host state.
    func ingest(line: Data, tabId: Int, checkout: Bool, emulated: Bool? = nil) {
        let (lanes, remoteLanes, statusFrame, hostState): ([DomLaneSending], [DomLaneSending], Data?, Data?) = lock.withLock { state in
            state.buffer.ingest(line: line, checkout: checkout)
            // Batches only flow while a tab is recording, so a batch means the extension is reachable.
            let becameConnected = !state.extConnected
            var changed = state.lastTabId != tabId || becameConnected
            if let emulated, state.emulated != emulated { state.emulated = emulated; changed = true }
            state.extConnected = true
            state.lastTabId = tabId
            let remote = Array(state.lanes.values)
            let destinations = remote + [state.localProjection].compactMap { $0 }
            return (
                destinations,
                remote,
                changed ? statusFrameLocked(state) : nil,
                becameConnected ? hostStateFrameLocked(state) : nil
            )
        }
        // A lane whose stream died without a session-end stays in the map until the next attach or
        // session-end; its send() enqueues a Task that fails at stream.send and logs -- benign, and
        // identical to the shipping graphics lane. One lane per fingerprint (replaced via attach,
        // never accumulated), so no unbounded growth.
        if let hostState { for lane in remoteLanes { lane.send(hostState) } }
        for lane in lanes { lane.send(line) }
        if let statusFrame { for lane in lanes { lane.send(statusFrame) } }
    }

    // ADR-0046: the native-messaging bridge to the Chrome extension connected/disconnected. Push the
    // fresh reachability to every attached lane. A disconnect also means nothing is recording.
    func setExtConnected(_ connected: Bool) {
        let (lanes, remoteLanes, statusFrame, hostState): ([DomLaneSending], [DomLaneSending], Data?, Data?) = lock.withLock { state in
            state.extConnected = connected
            // ADR-0048: a disconnect means nothing is recording and the emulation state is no longer
            // known; reset to desktop so the client shows a truthful default until a batch's `em` stamp
            // re-establishes it on reconnect.
            if !connected { state.lastTabId = nil; state.emulated = false }
            let remote = Array(state.lanes.values)
            let destinations = remote + [state.localProjection].compactMap { $0 }
            return (destinations, remote, statusFrameLocked(state), hostStateFrameLocked(state))
        }
        if let statusFrame { for lane in lanes { lane.send(statusFrame) } }
        if let hostState { for lane in remoteLanes { lane.send(hostState) } }
    }

    // A phone opened the .dom lane: replace any prior lane for that fingerprint, then seed the new
    // lane with host/browser metadata and the buffered checkout before live updates can interleave.
    func attach(_ lane: DomLaneSending, for fingerprint: DeviceFingerprint) {
        let prior: DomLaneSending? = lock.withLock { state in
            let prior = state.lanes[fingerprint]
            state.lanes[fingerprint] = lane
            if let hostState = hostStateFrameLocked(state) { lane.send(hostState) }
            if let browserState = state.browserState { lane.send(browserState) }
            for line in state.buffer.snapshot() { lane.send(line) }
            if let statusFrame = statusFrameLocked(state) { lane.send(statusFrame) }
            return prior
        }
        prior?.close()
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
