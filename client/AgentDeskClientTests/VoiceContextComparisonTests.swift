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

    @Test func matchLocationAcceptsTargetInAnAlternative() {
        let reading = reading("sink", alternatives: ["think"])
        #expect(VoiceContextComparison.matchLocation(in: reading, target: "think") == .alternative)
        #expect(!VoiceContextComparison.matches(reading.top.text, target: "think"))
    }

    @Test func matchLocationDistinguishesTopAlternativeAndAbsent() {
        #expect(
            VoiceContextComparison.matchLocation(
                in: reading("think", alternatives: ["sink"]),
                target: "think"
            ) == .topResult
        )
        #expect(
            VoiceContextComparison.matchLocation(
                in: reading("sink", alternatives: ["think"]),
                target: "think"
            ) == .alternative
        )
        #expect(
            VoiceContextComparison.matchLocation(
                in: reading("sink", alternatives: ["zinc"]),
                target: "think"
            ) == .absent
        )
    }

    // The four verdicts are the whole point of running two passes.
    @Test func verdictIsClearWhenBothPassesRecognizeTheTarget() {
        let reading = reading("think")
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
                withoutContext: reading("sink"),
                withContext: reading("think")
            ) == .contextRescued
        )
    }

    @Test func verdictUsesUnaidedAlternatives() {
        #expect(
            VoiceContextComparison.verdict(
                target: "think",
                withoutContext: reading("sink", alternatives: ["think"]),
                withContext: reading("think")
            ) == .clear
        )
    }

    @Test func verdictUsesContextualAlternatives() {
        #expect(
            VoiceContextComparison.verdict(
                target: "think",
                withoutContext: reading("sink"),
                withContext: reading("sink", alternatives: ["think"])
            ) == .contextRescued
        )
    }

    @Test func verdictIsMissedWhenNeitherPassRecognizes() {
        let reading = reading("sink")
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
                withoutContext: reading("think"),
                withContext: reading("sink")
            ) == .inconsistent
        )
    }

    @Test func confusionsListWhatTheUtteranceWasHeardAsInstead() {
        let reading = reading("sink", alternatives: ["think", "zinc", "Sink."])
        // The target is excluded, and "Sink." dedupes against "sink" after
        // normalization so the learner is not shown the same word twice.
        #expect(VoiceContextComparison.confusions(target: "think", reading: reading) == ["sink", "zinc"])
    }

    @Test func confusionsAreEmptyWhenOnlyTheTargetWasHeard() {
        let reading = reading("think", alternatives: ["I think"])
        #expect(VoiceContextComparison.confusions(target: "think", reading: reading).isEmpty)
    }

    private func reading(
        _ top: String,
        alternatives: [String] = []
    ) -> VoiceReading {
        VoiceReading(
            top: VoiceRecognitionCandidate(text: top, confidence: nil),
            alternatives: alternatives.map {
                VoiceRecognitionCandidate(text: $0, confidence: nil)
            }
        )
    }
}
