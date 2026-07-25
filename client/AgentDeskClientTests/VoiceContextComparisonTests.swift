import Testing

// The pure half of the speech-context probe: how two transcription readings of
// the same audio are compared against the target phrase. The Speech and
// AVFoundation machinery is not exercised here; this pins the comparison
// semantics that decide what the user is told.
struct VoiceContextComparisonTests {
    @Test func normalizeStripsCasingAndPunctuation() {
        #expect(VoiceContextComparison.normalize("  Think. ") == "think")
        #expect(VoiceContextComparison.normalize("I think, therefore") == "i think therefore")
        #expect(VoiceContextComparison.normalize("") == "")
    }

    // Recognition wraps short practice words in filler often enough that exact
    // equality would report a gap where the recognizer still found the target.
    @Test func matchesFindsTargetInsideSurroundingFiller() {
        #expect(VoiceContextComparison.matches("I think so", target: "think"))
        #expect(VoiceContextComparison.matches("Think!", target: "think"))
    }

    // The inverse trap: substring matching would accept "ink" inside "think",
    // so matching is on word boundaries.
    @Test func matchesRejectsPartialWords() {
        #expect(!VoiceContextComparison.matches("think", target: "ink"))
        #expect(!VoiceContextComparison.matches("sink", target: "think"))
        #expect(!VoiceContextComparison.matches("think", target: ""))
    }

    @Test func matchesRequiresContiguousMultiWordTargets() {
        #expect(VoiceContextComparison.matches("please think it over", target: "think it"))
        #expect(!VoiceContextComparison.matches("think about it", target: "think it"))
    }

    @Test func anyMatchesAcceptsTargetInAnAlternative() {
        let reading = VoiceReading(text: "sink", alternatives: ["think"], confidence: nil)
        #expect(VoiceContextComparison.anyMatches(reading, target: "think"))
        #expect(!VoiceContextComparison.matches(reading.text, target: "think"))
    }

    // The four verdicts are the whole point of running two passes.
    @Test func verdictIsClearWhenBothPassesRecognizeTheTarget() {
        let reading = VoiceReading(text: "think", alternatives: [], confidence: nil)
        #expect(
            VoiceContextComparison.verdict(
                target: "think",
                withoutContext: reading,
                withContext: reading
            ) == .clear
        )
    }

    @Test func verdictIsContextRescuedWhenOnlyTheSeededPassRecognizes() {
        #expect(
            VoiceContextComparison.verdict(
                target: "think",
                withoutContext: VoiceReading(text: "sink", alternatives: [], confidence: nil),
                withContext: VoiceReading(text: "think", alternatives: [], confidence: nil)
            ) == .contextRescued
        )
    }

    @Test func verdictUsesUnaidedAlternatives() {
        #expect(
            VoiceContextComparison.verdict(
                target: "think",
                withoutContext: VoiceReading(
                    text: "sink",
                    alternatives: ["think"],
                    confidence: nil
                ),
                withContext: VoiceReading(text: "think", alternatives: [], confidence: nil)
            ) == .clear
        )
    }

    @Test func verdictUsesContextualAlternatives() {
        #expect(
            VoiceContextComparison.verdict(
                target: "think",
                withoutContext: VoiceReading(text: "sink", alternatives: [], confidence: nil),
                withContext: VoiceReading(
                    text: "sink",
                    alternatives: ["think"],
                    confidence: nil
                )
            ) == .contextRescued
        )
    }

    @Test func verdictIsMissedWhenNeitherPassRecognizes() {
        let reading = VoiceReading(text: "sink", alternatives: [], confidence: nil)
        #expect(
            VoiceContextComparison.verdict(
                target: "think",
                withoutContext: reading,
                withContext: reading
            ) == .missed
        )
    }

    // Reported rather than folded into another case: this combination means the
    // context pass misbehaved, and hiding it would let that look like a stable
    // recognition result.
    @Test func verdictIsInconsistentWhenContextLosesTheTarget() {
        #expect(
            VoiceContextComparison.verdict(
                target: "think",
                withoutContext: VoiceReading(text: "think", alternatives: [], confidence: nil),
                withContext: VoiceReading(text: "sink", alternatives: [], confidence: nil)
            ) == .inconsistent
        )
    }

    @Test func confusionsListWhatTheUtteranceWasHeardAsInstead() {
        let reading = VoiceReading(
            text: "sink",
            alternatives: ["think", "zinc", "Sink."],
            confidence: nil
        )
        // The target is excluded, and "Sink." dedupes against "sink" after
        // normalization so the learner is not shown the same word twice.
        #expect(VoiceContextComparison.confusions(target: "think", reading: reading) == ["sink", "zinc"])
    }

    @Test func confusionsAreEmptyWhenOnlyTheTargetWasHeard() {
        let reading = VoiceReading(text: "think", alternatives: ["I think"], confidence: nil)
        #expect(VoiceContextComparison.confusions(target: "think", reading: reading).isEmpty)
    }
}
