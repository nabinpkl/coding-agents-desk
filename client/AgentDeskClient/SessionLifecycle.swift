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
        guard Self.elapsed(from: lastEvidenceUptimeNs, to: nowNs) >= quietPingNs else { return nil }
        if let lastPing = lastPingUptimeNs, Self.elapsed(from: lastPing, to: nowNs) < quietPingNs { return nil }
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
        let silentNs = Self.elapsed(from: lastEvidenceUptimeNs, to: nowNs)
        guard silentNs >= silenceLimitNs else { return nil }
        declared = true
        return Double(silentNs) / 1_000_000
    }

    /// For log lines and diagnostics.
    func msSinceEvidence(nowNs: UInt64) -> Double {
        Double(Self.elapsed(from: lastEvidenceUptimeNs, to: nowNs)) / 1_000_000
    }

    /// How long the most recent ping has gone unanswered, or nil while no ping is outstanding.
    ///
    /// A ping is a request with a due reply, and this is the request-deadline view of the
    /// clock: "I asked and nothing came back" is knowable one round-trip after the ask, where
    /// the wall-clock quiet rung needs seconds of calendar to say the same thing. Outstanding
    /// means issued strictly after the last evidence -- any evidence, not just the pong,
    /// because a carrier that delivers anything at all has answered the only question the
    /// ping was asking. Equal stamps (evidence and ping in the same caller tick) count as
    /// answered so a healthy carrier's forced birth ping can never look overdue.
    func msSinceUnansweredPing(nowNs: UInt64) -> Double? {
        guard let lastPing = lastPingUptimeNs, lastPing > lastEvidenceUptimeNs else { return nil }
        return Double(Self.elapsed(from: lastPing, to: nowNs)) / 1_000_000
    }

    /// Clamped, never wrapping. Evidence is stamped on receive paths while callers capture
    /// their `nowNs` earlier in a report tick, so evidence can legitimately be NEWER than a
    /// caller's now. The wrapping subtraction this replaces turned that microsecond skew into
    /// a 2^64ns "silence" -- measured on device as `sessionUnreachable silentMs=2^64/1e6`,
    /// ending a healthy session instantly.
    private static func elapsed(from startNs: UInt64, to nowNs: UInt64) -> UInt64 {
        nowNs >= startNs ? nowNs - startNs : 0
    }
}

/// Why the CURRENT carrier should be replaced, as distinct from the session being over.
enum SessionCarrierStaleReason: String {
    /// A ping went out on a carrier that has never delivered a byte, and its reply is
    /// overdue. The fastest detector: fires one missed round-trip after the birth ping.
    case unansweredPing = "unanswered-ping"
    /// The carrier's streams may answer, but the datagram lane never delivered a single
    /// video packet despite the first frame being requested at attach.
    case noFirstDatagram = "no-first-datagram"
    /// The wall-clock floor: quiet across all lanes for the full stale window.
    case quiet = "quiet"
}

/// Whether the CURRENT carrier should be replaced, and why.
///
/// The rung between "quiet" and "dead" that the first cut of ADR-0104 lacked, measured
/// missing on device: a connection went zombie -- the OS never reported it failed, so no
/// carrier-lost event fired -- and the only detector left was the session clock, whose only
/// action was ending the session. The host was answering the whole time; a redial at any
/// point would have reconnected. So: a carrier that comes up empty is swapped and the
/// question asked again on a fresh one. Only silence that survives swaps reaches the verdict.
///
/// Three rungs, fastest first, all of them swap-only -- none is ever a session verdict:
///
/// - `unansweredPing`: request-deadline detection for a carrier born deaf. Every carrier
///   pings at its first report tick; a carrier with zero lifetime evidence whose ping goes
///   unanswered is dead NOW, not after the wall-clock window. Measured motivation: a
///   foreground resume connected in 350ms, then sat 6s waiting for the quiet rung while its
///   newborn carrier delivered nothing -- the unanswered ping proved the same fact at ~1.5s.
///   Gated to zero-evidence carriers so a slow-but-alive path can never thrash: one
///   delivered byte moves the carrier to the wall-clock floor.
/// - `noFirstDatagram`: the lanes fail independently (measured: streams answering while 38%
///   of datagram replies vanished), so a pong must not vouch for the video path. The first
///   frame is requested at attach and its packets normally arrive within one RTT; a carrier
///   that has never produced a single datagram past this deadline has a dead video lane no
///   ping can see. Assumes the host produces continuously (it does, even at rest -- delta
///   frames at full fps); if production ever pauses at idle this rung must learn that.
/// - `quiet`: the original floor. Both clocks matter: `msSinceEvidence` alone would declare
///   a replacement carrier stale the instant it attached mid-silence, swapping in a storm;
///   giving each carrier its own grace (`msSinceCarrierStart`) means every fresh connection
///   gets the full window while the session clock keeps counting toward the real verdict.
enum SessionCarrierStaleness {
    static func staleReason(
        msSinceEvidence: Double,
        msSinceCarrierStart: Double,
        msSinceUnansweredPing: Double?,
        carrierSawDatagram: Bool,
        staleLimitMs: Double,
        unansweredPingLimitMs: Double,
        firstDatagramLimitMs: Double
    ) -> SessionCarrierStaleReason? {
        // "Never delivered a byte" reads as: the session's last evidence predates this
        // carrier's birth. Evidence during its life resets the session clock below carrier
        // age, so one delivered byte permanently retires this rung for the carrier.
        if msSinceEvidence >= msSinceCarrierStart,
           let pingMs = msSinceUnansweredPing, pingMs >= unansweredPingLimitMs {
            return .unansweredPing
        }
        if !carrierSawDatagram, msSinceCarrierStart >= firstDatagramLimitMs {
            return .noFirstDatagram
        }
        if min(msSinceEvidence, msSinceCarrierStart) >= staleLimitMs {
            return .quiet
        }
        return nil
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

    func msSinceUnansweredPing(nowNs: UInt64) -> Double? {
        clock.withLock { $0.msSinceUnansweredPing(nowNs: nowNs) }
    }
}
