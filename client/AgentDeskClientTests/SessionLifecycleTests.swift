import Testing

/// ADR-0104. The one clock that may end a session, tested as pure logic because every number
/// in it has a measured failure behind it: the detectors this replaced tore a session down in
/// the same 500ms window that delivered 1,143 video frames without a drop.
struct SessionLivenessClockTests {
    private let base: UInt64 = 1_000_000_000_000
    private func ms(_ value: Int) -> UInt64 { UInt64(value) * 1_000_000 }

    private func makeClock() -> SessionLivenessClock {
        SessionLivenessClock(nowNs: base, quietPingMs: 2_000, silenceLimitMs: 15_000)
    }

    // MARK: Quiet pings

    /// While anything at all is arriving, the clock manufactures nothing: pings exist only
    /// for the static-screen case where silence-of-traffic is ambiguous.
    @Test func evidenceSuppressesPings() {
        var clock = makeClock()
        clock.noteEvidence(nowNs: base + ms(1_900))
        let atTwo = clock.pingSequenceIfQuiet(nowNs: base + ms(2_000))
        let later = clock.pingSequenceIfQuiet(nowNs: base + ms(3_800))
        #expect(atTwo == nil)
        #expect(later == nil)
    }

    @Test func quietProducesAPingAtTheIntervalNotPerTick() {
        var clock = makeClock()
        // 500ms report ticks; the first past the quiet threshold pings, the next does not.
        let first = clock.pingSequenceIfQuiet(nowNs: base + ms(2_000))
        let paced = clock.pingSequenceIfQuiet(nowNs: base + ms(2_500))
        let second = clock.pingSequenceIfQuiet(nowNs: base + ms(4_000))
        #expect(first == 1)
        #expect(paced == nil)
        #expect(second == 2)
    }

    /// A link change asks for the truth sooner. It skips the quiet gate entirely -- asking
    /// early can only shorten the time to an answer in either direction.
    @Test func aForcedPingSkipsTheQuietGate() {
        var clock = makeClock()
        clock.noteEvidence(nowNs: base + ms(100))
        let forced = clock.forcedPingSequence(nowNs: base + ms(200))
        #expect(forced == 1)
    }

    // MARK: Pongs

    /// Only a pong answering a ping this clock issued counts -- a replayed or misrouted frame
    /// must not keep a dead session looking alive.
    @Test func aPongForAnUnissuedSequenceIsNotEvidence() {
        var clock = makeClock()
        let phantom = clock.notePong(sequence: 5, nowNs: base + ms(100))
        _ = clock.pingSequenceIfQuiet(nowNs: base + ms(2_000))
        let answered = clock.notePong(sequence: 1, nowNs: base + ms(2_100))
        #expect(!phantom)
        #expect(answered)
    }

    // MARK: The verdict

    /// Both bounds are the point of the number: the limit rides out the longest measured
    /// self-healing stall (9s) and sits inside the host's 20s resume TTL.
    @Test func theVerdictRidesOutSelfHealingStallsButNotARealDeath() {
        var clock = makeClock()
        let duringStall = clock.silentVerdict(nowNs: base + ms(9_000))
        let afterLimit = clock.silentVerdict(nowNs: base + ms(15_000))
        #expect(duringStall == nil)
        #expect(afterLimit != nil)
    }

    @Test func theVerdictIsInclusiveAtItsBoundary() {
        var clock = makeClock()
        let justUnder = clock.silentVerdict(nowNs: base + ms(14_999))
        let atLimit = clock.silentVerdict(nowNs: base + ms(15_000))
        #expect(justUnder == nil)
        #expect(atLimit == 15_000)
    }

    /// One silence, one verdict. The report loop ticks every 500ms; without the latch a
    /// single dead spell would yield a teardown per tick, racing teardowns for one cause.
    @Test func oneSilenceYieldsExactlyOneVerdict() {
        var clock = makeClock()
        let verdict = clock.silentVerdict(nowNs: base + ms(15_000))
        let nextTick = clock.silentVerdict(nowNs: base + ms(15_500))
        let muchLater = clock.silentVerdict(nowNs: base + ms(60_000))
        #expect(verdict != nil)
        #expect(nextTick == nil)
        #expect(muchLater == nil)
    }

    /// Evidence un-latches: a session that answers after the verdict but before teardown
    /// completes is trusted again, and a NEW silence can earn a new verdict.
    @Test func evidenceAfterAVerdictRearmsTheClock() {
        var clock = makeClock()
        let firstVerdict = clock.silentVerdict(nowNs: base + ms(15_000))
        clock.noteEvidence(nowNs: base + ms(16_000))
        let whileAnswering = clock.silentVerdict(nowNs: base + ms(20_000))
        let secondSilence = clock.silentVerdict(nowNs: base + ms(31_000))
        #expect(firstVerdict != nil)
        #expect(whileAnswering == nil)
        #expect(secondSilence != nil)
    }

    /// The underflow regression. Evidence is stamped on receive paths, callers capture their
    /// `nowNs` earlier in a tick, so evidence can be NEWER than a caller's now. The wrapping
    /// subtraction this pins against turned that microsecond skew into a 2^64ns "silence" --
    /// measured on device as `sessionUnreachable silentMs=18446744073708`, ending a healthy
    /// session instantly.
    @Test func evidenceNewerThanTheCallersClockIsNotSilence() {
        var clock = makeClock()
        clock.noteEvidence(nowNs: base + ms(5_000))
        let verdict = clock.silentVerdict(nowNs: base + ms(4_999))
        #expect(verdict == nil)
        #expect(clock.msSinceEvidence(nowNs: base + ms(4_999)) == 0)
        let ping = clock.pingSequenceIfQuiet(nowNs: base + ms(4_999))
        #expect(ping == nil)
    }

    /// The property the whole redesign exists for: pings going OUT prove nothing and reset
    /// nothing. Only inbound evidence moves the clock, so a redial storm of send-only
    /// carriers still accumulates the silence that ends the session.
    @Test func sendingPingsDoesNotPostponeTheVerdict() {
        var clock = makeClock()
        _ = clock.pingSequenceIfQuiet(nowNs: base + ms(2_000))
        _ = clock.forcedPingSequence(nowNs: base + ms(8_000))
        _ = clock.pingSequenceIfQuiet(nowNs: base + ms(14_000))
        let verdict = clock.silentVerdict(nowNs: base + ms(15_000))
        #expect(verdict != nil)
    }

    // MARK: The request deadline

    /// No ask, no deadline: the clock reports an unanswered ping only once one exists.
    @Test func noOutstandingPingMeansNoDeadline() {
        let clock = makeClock()
        #expect(clock.msSinceUnansweredPing(nowNs: base + ms(5_000)) == nil)
    }

    /// A ping is a request with a due reply: from the moment it is issued with no evidence
    /// after it, the clock counts how overdue the answer is.
    @Test func anUnansweredPingAccumulatesItsOverdueTime() {
        var clock = makeClock()
        _ = clock.forcedPingSequence(nowNs: base + ms(500))
        let overdue = clock.msSinceUnansweredPing(nowNs: base + ms(1_500))
        #expect(overdue == 1_000)
    }

    /// ANY evidence answers the outstanding ping, not just its pong -- a carrier that
    /// delivers anything at all has answered the only question the ping was asking.
    @Test func anyEvidenceClearsTheOutstandingPing() {
        var clock = makeClock()
        _ = clock.forcedPingSequence(nowNs: base + ms(500))
        clock.noteEvidence(nowNs: base + ms(700))
        #expect(clock.msSinceUnansweredPing(nowNs: base + ms(5_000)) == nil)
    }

    /// The birth-tick race: the report loop notes arrival evidence and then sends the forced
    /// birth ping with the SAME timestamp. Equal stamps count as answered, so a healthy
    /// carrier's birth ping can never look overdue even if its pong is lost.
    @Test func aPingStampedWithItsTicksEvidenceIsNotOutstanding() {
        var clock = makeClock()
        clock.noteEvidence(nowNs: base + ms(500))
        _ = clock.forcedPingSequence(nowNs: base + ms(500))
        #expect(clock.msSinceUnansweredPing(nowNs: base + ms(5_000)) == nil)
    }
}

/// The monitor is the clock shared across carriers; identity is the session id.
struct SessionLivenessMonitorTests {
    @Test func silenceAccumulatesAcrossWhatWouldBeACarrierSwap() {
        let base: UInt64 = 5_000_000_000_000
        let monitor = SessionLivenessMonitor(sessionId: "abc", nowNs: base, quietPingMs: 2_000, silenceLimitMs: 15_000)
        // First carrier lives 6 quiet seconds and dies; a second carrier adopts the same
        // monitor and the silence keeps counting -- 15s total, not 15s per carrier.
        let midway = monitor.silentVerdict(nowNs: base + 6_000_000_000)
        let atLimit = monitor.silentVerdict(nowNs: base + 15_000_000_000)
        #expect(midway == nil)
        #expect(atLimit != nil)
    }
}

/// The rung between "quiet" and "dead": a carrier that comes up empty is replaced, and only
/// silence that survives replacement reaches the session verdict. Three rungs -- two
/// request-deadline detectors for carriers born dead, and the wall-clock floor.
struct SessionCarrierStalenessTests {
    private func reason(
        msSinceEvidence: Double,
        msSinceCarrierStart: Double,
        msSinceUnansweredPing: Double? = nil,
        carrierSawDatagram: Bool = true
    ) -> SessionCarrierStaleReason? {
        SessionCarrierStaleness.staleReason(
            msSinceEvidence: msSinceEvidence,
            msSinceCarrierStart: msSinceCarrierStart,
            msSinceUnansweredPing: msSinceUnansweredPing,
            carrierSawDatagram: carrierSawDatagram,
            staleLimitMs: 6_000,
            unansweredPingLimitMs: 1_000,
            firstDatagramLimitMs: 2_000
        )
    }

    // MARK: The wall-clock floor

    /// The measured zombie: evidence long quiet on a carrier well past its grace. This is the
    /// case that used to fall through to the session verdict while the host was answering.
    @Test func aQuietMatureCarrierIsStale() {
        #expect(reason(msSinceEvidence: 6_000, msSinceCarrierStart: 46_000) == .quiet)
    }

    /// A replacement carrier attached mid-silence must get its own full grace, or a reattach
    /// storm swaps carriers as fast as they come up and never gives one time to answer.
    @Test func aFreshCarrierIsNotStaleHoweverLongTheSilence() {
        #expect(reason(msSinceEvidence: 14_000, msSinceCarrierStart: 500) == nil)
    }

    /// Evidence flowing means not stale, whatever the carrier's age.
    @Test func evidenceKeepsAnOldCarrierFresh() {
        #expect(reason(msSinceEvidence: 1_000, msSinceCarrierStart: 300_000) == nil)
    }

    @Test func stalenessIsInclusiveAtItsBoundary() {
        #expect(reason(msSinceEvidence: 6_000, msSinceCarrierStart: 6_000) == .quiet)
        #expect(reason(msSinceEvidence: 5_999, msSinceCarrierStart: 6_000) == nil)
    }

    // MARK: The unanswered birth ping

    /// The measured 7-second resume: a carrier connected in 350ms, never delivered a byte,
    /// and sat out the full wall-clock window. The unanswered birth ping proves the same
    /// fact one missed round-trip after the ask.
    @Test func aNewbornWhoseBirthPingWentUnansweredIsStaleNow() {
        #expect(reason(
            msSinceEvidence: 5_000,
            msSinceCarrierStart: 1_600,
            msSinceUnansweredPing: 1_000,
            carrierSawDatagram: false
        ) == .unansweredPing)
    }

    @Test func theBirthPingDeadlineIsInclusiveAtItsBoundary() {
        #expect(reason(
            msSinceEvidence: 5_000,
            msSinceCarrierStart: 1_600,
            msSinceUnansweredPing: 999,
            carrierSawDatagram: false
        ) == nil)
    }

    /// One delivered byte retires the fast rung: a carrier with lifetime evidence keeps the
    /// full wall-clock grace even when a later ping goes unanswered, so a slow-but-alive
    /// path can never thrash through carriers at ping cadence.
    @Test func aCarrierWithHistoryIsNeverFastSwappedByAPing() {
        #expect(reason(
            msSinceEvidence: 3_000,
            msSinceCarrierStart: 46_000,
            msSinceUnansweredPing: 2_500
        ) == nil)
    }

    // MARK: The missing first datagram

    /// The lanes fail independently (measured: streams answering while 38% of datagram
    /// replies vanished). Pongs keep session evidence fresh, so without this rung a carrier
    /// with a dead video lane would look healthy forever.
    @Test func answeringPingsCannotVouchForADeadVideoLane() {
        #expect(reason(
            msSinceEvidence: 200,
            msSinceCarrierStart: 2_000,
            carrierSawDatagram: false
        ) == .noFirstDatagram)
    }

    @Test func theFirstDatagramRetiresItsRungPermanently() {
        #expect(reason(
            msSinceEvidence: 200,
            msSinceCarrierStart: 300_000,
            carrierSawDatagram: true
        ) == nil)
    }

    @Test func theFirstDatagramDeadlineGivesTheFirstFrameItsWindow() {
        #expect(reason(
            msSinceEvidence: 200,
            msSinceCarrierStart: 1_999,
            carrierSawDatagram: false
        ) == nil)
    }
}
