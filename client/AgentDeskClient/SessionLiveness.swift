import Foundation
import os
import AgentDeskWire

/// ADR-0104: how long it has been since this SESSION last completed a round trip with the host.
///
/// The state lives here, outside the media transport, because the transport is per-connection
/// and the question is not. A handover replaces the transport; it does not replace the session,
/// and a clock that restarted with every transport could never distinguish "we have been unable
/// to reach the host for eight seconds across three connection attempts" from "this connection
/// is two hundred milliseconds old". The first is a dead session. The second is a normal Tuesday
/// on a phone, and the previous design tore sessions down for it.
///
/// Keeping the sequence here too means a ping sent on one connection can be answered on the
/// next: the pong carries the sequence and the session id, and neither is a property of the
/// socket it arrived over.
final class SessionLivenessTracker: @unchecked Sendable {
    private struct State {
        var nextSequence: UInt64 = 1
        /// Nil until the first attach seeds it. A session that has never had a lane must not be
        /// declared dead for silence nobody promised to break.
        var lastRoundTripUptimeNs: UInt64?
        var pingsSent: UInt64 = 0
        var pongsReceived: UInt64 = 0
        /// Latched so one silence yields one verdict rather than one per report window while the
        /// teardown runs. Cleared by a completed round trip, so a session that recovers before
        /// the teardown finishes is trusted again.
        var declared = false
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    /// Start (or restart) the clock without crediting a round trip.
    ///
    /// Called when a lane attaches. Seeding rather than leaving nil is what catches a host that
    /// accepts the stream and then never answers; not crediting is what keeps an attach from
    /// papering over a session that has been unanswered for the last five seconds.
    func noteLaneAttached(nowNs: UInt64) {
        state.withLock { state in
            if state.lastRoundTripUptimeNs == nil {
                state.lastRoundTripUptimeNs = nowNs
            }
        }
    }

    func nextPingSequence() -> UInt64 {
        state.withLock { state in
            let sequence = state.nextSequence
            state.nextSequence &+= 1
            state.pingsSent &+= 1
            return sequence
        }
    }

    /// A pong came back. Only a pong for a ping we actually sent counts, which is what makes a
    /// replayed or misrouted frame unable to keep a dead session looking alive.
    func noteRoundTrip(sequence: UInt64, nowNs: UInt64) -> Bool {
        state.withLock { state in
            guard sequence < state.nextSequence else { return false }
            state.lastRoundTripUptimeNs = nowNs
            state.pongsReceived &+= 1
            state.declared = false
            return true
        }
    }

    /// The verdict, or nil while the session is still answering.
    ///
    /// One authority. Nothing else in the client may conclude the session is gone -- not a link
    /// change, not a quiet datagram flow, not a dead socket. Those are reasons to ask again
    /// sooner, and this is the only thing that decides.
    func declareIfSilent(
        nowNs: UInt64,
        silenceLimitMs: Double = SessionLivenessPolicy.defaultSilenceLimitMs
    ) -> (silentMs: Double, pings: UInt64, pongs: UInt64)? {
        state.withLock { state in
            guard !state.declared, let last = state.lastRoundTripUptimeNs else { return nil }
            let silentMs = Double(nowNs >= last ? nowNs - last : 0) / 1_000_000
            guard SessionLivenessPolicy.shouldDeclareSessionGone(
                msSinceLastRoundTrip: silentMs,
                silenceLimitMs: silenceLimitMs
            ) else { return nil }
            state.declared = true
            return (silentMs, state.pingsSent, state.pongsReceived)
        }
    }

    /// For diagnostics and log lines; nil before the first attach.
    func msSinceLastRoundTrip(nowNs: UInt64) -> Double? {
        state.withLock { state in
            guard let last = state.lastRoundTripUptimeNs else { return nil }
            return Double(nowNs >= last ? nowNs - last : 0) / 1_000_000
        }
    }
}

/// The tracker for the session currently being served.
///
/// Exactly one is retained, replaced when the session id changes. A resume keeps its id, so it
/// keeps its clock across the transport swap -- which is the entire point. A fresh dial has a
/// new id and correctly starts over. Holding one rather than a map means there is no bookkeeping
/// to get wrong and nothing to leak when a session ends without saying so.
enum SessionLivenessRegistry {
    private nonisolated(unsafe) static let current = OSAllocatedUnfairLock(
        initialState: (id: String, tracker: SessionLivenessTracker)?.none
    )

    static func tracker(for sessionId: String) -> SessionLivenessTracker {
        current.withLock { current in
            if let existing = current, existing.id == sessionId {
                return existing.tracker
            }
            let tracker = SessionLivenessTracker()
            current = (sessionId, tracker)
            return tracker
        }
    }
}
