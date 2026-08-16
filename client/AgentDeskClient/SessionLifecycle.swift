import Foundation
import os

/// ADR-0104: the session's liveness clock -- the ONE place that decides a session is gone.
///
/// The clock measures time since the last **evidence**: any inbound proof that the host and
/// this client completed an exchange. A decoded datagram, an input-lane push, a completed
/// handshake, a pong -- all equal. This is the correction to every previous design, each of
/// which watched one signal (datagram echoes, a link change, one stream's heartbeat) and so
/// could reach a verdict that contradicted the others: the final measured failure tore a
/// session down in the same 500ms window that delivered 1,143 video frames without a drop.
///
/// Pure logic, no timers of its own -- callers feed it `nowNs` from their existing loops, so
/// every rule here is unit-testable without a connection.
struct SessionLivenessClock {
    private var lastEvidenceUptimeNs: UInt64
    private var lastPingUptimeNs: UInt64?
    private var nextSequence: UInt64 = 1
    private var declared = false

    let quietPingNs: UInt64
    let silenceLimitNs: UInt64

    // No `Config` defaults here: this file compiles into the unit-test target, which is the
    // reason the numbers arrive as parameters (the monitor below passes the Config values).
    init(nowNs: UInt64, quietPingMs: Int, silenceLimitMs: Int) {
        // Seeded at creation: the session was just established by a completed handshake,
        // which is itself an exchange.
        self.lastEvidenceUptimeNs = nowNs
        self.quietPingNs = UInt64(quietPingMs) * 1_000_000
        self.silenceLimitNs = UInt64(silenceLimitMs) * 1_000_000
    }

    /// Any inbound proof of an exchange. Un-latches a declared verdict, so a session that
    /// answers after the verdict but before teardown completes is trusted again.
    mutating func noteEvidence(nowNs: UInt64) {
        lastEvidenceUptimeNs = max(lastEvidenceUptimeNs, nowNs)
        declared = false
    }

    /// Whether it is time to manufacture traffic, and the sequence to send if so.
    ///
    /// Pings only exist for the quiet case -- a static screen on an idle session produces no
    /// datagrams and no pushes, and without them silence-of-evidence would be ambiguous.
    /// While anything else is flowing this never fires. Also paced against its own last send
    /// so a quiet session asks at the ping interval, not once per caller tick.
    mutating func pingSequenceIfQuiet(nowNs: UInt64) -> UInt64? {
        guard nowNs &- lastEvidenceUptimeNs >= quietPingNs else { return nil }
        if let lastPing = lastPingUptimeNs, nowNs &- lastPing < quietPingNs { return nil }
        lastPingUptimeNs = nowNs
        let sequence = nextSequence
        nextSequence &+= 1
        return sequence
    }

    /// A link change asked for the truth sooner: skip the quiet gate and the pacing. It can
    /// only shorten the time to an answer, in either direction -- a pong disarms the silence
    /// faster, and a dead path accumulates silence it was going to accumulate anyway.
    mutating func forcedPingSequence(nowNs: UInt64) -> UInt64 {
        lastPingUptimeNs = nowNs
        let sequence = nextSequence
        nextSequence &+= 1
        return sequence
    }

    /// A pong is only evidence when it answers a ping this clock actually issued -- a replayed
    /// or misrouted frame must not keep a dead session looking alive.
    mutating func notePong(sequence: UInt64, nowNs: UInt64) -> Bool {
        guard sequence < nextSequence else { return false }
        noteEvidence(nowNs: nowNs)
        return true
    }

    /// The verdict, delivered at most once per silence (latched; evidence un-latches).
    ///
    /// Inclusive at the boundary, and deliberately generous: the limit sits above the longest
    /// measured self-healing stall (9s) and inside the host's resume TTL (20s), so a session
    /// that comes back at the boundary is still a resume rather than a re-pair.
    mutating func silentVerdict(nowNs: UInt64) -> Double? {
        guard !declared else { return nil }
        let silentNs = nowNs &- lastEvidenceUptimeNs
        guard silentNs >= silenceLimitNs else { return nil }
        declared = true
        return Double(silentNs) / 1_000_000
    }

    /// For log lines and diagnostics.
    func msSinceEvidence(nowNs: UInt64) -> Double {
        Double(nowNs &- lastEvidenceUptimeNs) / 1_000_000
    }
}

/// Whether the CURRENT carrier should be replaced, as distinct from the session being over.
///
/// The rung between "quiet" and "dead" that the first cut of ADR-0104 lacked, measured
/// missing on device: a connection went zombie -- the OS never reported it failed, so no
/// carrier-lost event fired -- and the only detector left was the session clock, whose only
/// action was ending the session. The host was answering the whole time; a redial at any
/// point would have reconnected. So: evidence quiet past this limit means swap the carrier
/// and ask again on a fresh one. Only carriers that keep coming up empty reach the verdict.
///
/// Both clocks matter. `msSinceEvidence` alone would declare a replacement carrier stale the
/// instant it attached mid-silence, swapping in a storm; giving each carrier its own grace
/// (`msSinceCarrierStart`) means every fresh connection gets the full window to produce
/// evidence while the session clock keeps counting toward the real verdict underneath.
enum SessionCarrierStaleness {
    static func isStale(
        msSinceEvidence: Double,
        msSinceCarrierStart: Double,
        staleLimitMs: Double
    ) -> Bool {
        min(msSinceEvidence, msSinceCarrierStart) >= staleLimitMs
    }
}

/// The clock, shared between the session's owner (`PairingClient`) and whichever carrier is
/// current. A class on purpose: the transport is per-connection and this must not be -- a
/// redial that replaced the clock could never accumulate silence across a redial storm, and
/// "we have not completed an exchange in fifteen seconds across three carriers" is exactly
/// the fact the verdict needs.
///
/// Keyed to one session id. `PairingClient` keeps the instance while resumes keep the id and
/// replaces it when a fresh dial mints a new session.
final class SessionLivenessMonitor: @unchecked Sendable {
    let sessionId: String
    private let clock: OSAllocatedUnfairLock<SessionLivenessClock>

    init(sessionId: String, nowNs: UInt64, quietPingMs: Int, silenceLimitMs: Int) {
        self.sessionId = sessionId
        self.clock = OSAllocatedUnfairLock(initialState: SessionLivenessClock(
            nowNs: nowNs,
            quietPingMs: quietPingMs,
            silenceLimitMs: silenceLimitMs
        ))
    }

    func noteEvidence(nowNs: UInt64) {
        clock.withLock { $0.noteEvidence(nowNs: nowNs) }
    }

    func pingSequenceIfQuiet(nowNs: UInt64) -> UInt64? {
        clock.withLock { $0.pingSequenceIfQuiet(nowNs: nowNs) }
    }

    func forcedPingSequence(nowNs: UInt64) -> UInt64 {
        clock.withLock { $0.forcedPingSequence(nowNs: nowNs) }
    }

    @discardableResult
    func notePong(sequence: UInt64, nowNs: UInt64) -> Bool {
        clock.withLock { $0.notePong(sequence: sequence, nowNs: nowNs) }
    }

    func silentVerdict(nowNs: UInt64) -> Double? {
        clock.withLock { $0.silentVerdict(nowNs: nowNs) }
    }

    func msSinceEvidence(nowNs: UInt64) -> Double {
        clock.withLock { $0.msSinceEvidence(nowNs: nowNs) }
    }
}
