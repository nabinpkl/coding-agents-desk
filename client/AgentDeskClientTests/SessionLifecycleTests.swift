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
