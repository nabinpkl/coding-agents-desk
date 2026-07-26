import Foundation

struct VoicePassageWordPronunciation: Codable, Equatable, Sendable {
    let word: String
    let phones: [String]
    let isKnown: Bool
}

struct VoicePassageWordPhoneGroup: Codable, Equatable, Sendable {
    /// Nil only for raw phones that cannot be anchored because the transcript
    /// has no known reference pronunciation.
    let word: String?
    let heardPhones: [String]
    let referencePhones: [String]
    let hasReferencePronunciation: Bool
}

/// Groups an unconstrained raw-phone sequence against transcript words.
///
/// The model does not emit words or word boundaries. This is deliberately a
/// sequence alignment against the transcript's reference phones, not an
/// acoustic forced alignment. Every observed phone is retained: insertions are
/// assigned to the nearest aligned word, and phones with no possible anchor
/// are returned in an explicit unassigned group.
enum VoicePassagePhoneGrouper {
    private struct ReferencePhone {
        let phone: String
        let wordIndex: Int
    }

    private struct ReferenceAnchor {
        let wordIndex: Int
        let stepIndex: Int
    }

    private enum AlignmentStep {
        case paired(observedPhone: String, referenceIndex: Int)
        case inserted(observedPhone: String)
        case deleted(referenceIndex: Int)

        var referenceIndex: Int? {
            switch self {
            case .paired(_, let referenceIndex),
                 .deleted(let referenceIndex):
                referenceIndex
            case .inserted:
                nil
            }
        }
    }

    static func group(
        observedPhones: [String],
        words: [VoicePassageWordPronunciation]
    ) -> [VoicePassageWordPhoneGroup] {
        guard !words.isEmpty else {
            return observedPhones.isEmpty
                ? []
                : [
                    VoicePassageWordPhoneGroup(
                        word: nil,
                        heardPhones: observedPhones,
                        referencePhones: [],
                        hasReferencePronunciation: false
                    )
                ]
        }

        let reference = words.enumerated().flatMap {
            wordIndex,
            word in
            word.phones.map {
                ReferencePhone(
                    phone: $0,
                    wordIndex: wordIndex
                )
            }
        }
        var heardByWord = Array(
            repeating: [String](),
            count: words.count
        )
        var unassigned: [String] = []

        if reference.isEmpty {
            unassigned = observedPhones
        } else {
            let steps = alignmentSteps(
                observedPhones: observedPhones,
                reference: reference
            )
            let nextAnchorByStep = nextReferenceAnchorByStep(
                steps,
                reference: reference
            )
            var previousAnchor: ReferenceAnchor?

            for (stepIndex, step) in steps.enumerated() {
                switch step {
                case .paired(
                    let observedPhone,
                    let referenceIndex
                ):
                    let wordIndex =
                        reference[referenceIndex].wordIndex
                    heardByWord[wordIndex].append(observedPhone)
                    previousAnchor = ReferenceAnchor(
                        wordIndex: wordIndex,
                        stepIndex: stepIndex
                    )
                case .inserted(let observedPhone):
                    if let anchor = nearestAnchor(
                        to: stepIndex,
                        previous: previousAnchor,
                        next: nextAnchorByStep[stepIndex]
                    ) {
                        heardByWord[anchor.wordIndex].append(
                            observedPhone
                        )
                    } else {
                        unassigned.append(observedPhone)
                    }
                case .deleted(let referenceIndex):
                    previousAnchor = ReferenceAnchor(
                        wordIndex:
                            reference[referenceIndex].wordIndex,
                        stepIndex: stepIndex
                    )
                }
            }
        }

        var groups = words.enumerated().map {
            wordIndex,
            word in
            VoicePassageWordPhoneGroup(
                word: word.word,
                heardPhones: heardByWord[wordIndex],
                referencePhones: word.phones,
                hasReferencePronunciation: word.isKnown
            )
        }
        if !unassigned.isEmpty {
            groups.append(
                VoicePassageWordPhoneGroup(
                    word: nil,
                    heardPhones: unassigned,
                    referencePhones: [],
                    hasReferencePronunciation: false
                )
            )
        }
        return groups
    }

    private static func alignmentSteps(
        observedPhones: [String],
        reference: [ReferencePhone]
    ) -> [AlignmentStep] {
        let rowWidth = reference.count + 1
        var costs = [UInt16](
            repeating: 0,
            count: (observedPhones.count + 1) * rowWidth
        )
        for observedIndex in 0...observedPhones.count {
            costs[observedIndex * rowWidth] =
                UInt16(clamping: observedIndex)
        }
        for referenceIndex in 0...reference.count {
            costs[referenceIndex] =
                UInt16(clamping: referenceIndex)
        }

        if !observedPhones.isEmpty, !reference.isEmpty {
            for observedIndex in 1...observedPhones.count {
                for referenceIndex in 1...reference.count {
                    let substitutionCost: UInt16 =
                        observedPhones[observedIndex - 1]
                            == reference[referenceIndex - 1].phone
                            ? 0
                            : 1
                    let diagonal =
                        costs[
                            (observedIndex - 1) * rowWidth
                                + referenceIndex - 1
                        ] + substitutionCost
                    let insertion =
                        costs[
                            (observedIndex - 1) * rowWidth
                                + referenceIndex
                        ] + 1
                    let deletion =
                        costs[
                            observedIndex * rowWidth
                                + referenceIndex - 1
                        ] + 1
                    costs[
                        observedIndex * rowWidth + referenceIndex
                    ] = min(
                        diagonal,
                        min(insertion, deletion)
                    )
                }
            }
        }

        var observedIndex = observedPhones.count
        var referenceIndex = reference.count
        var reversed: [AlignmentStep] = []
        reversed.reserveCapacity(
            observedPhones.count + reference.count
        )

        while observedIndex > 0 || referenceIndex > 0 {
            let current =
                costs[observedIndex * rowWidth + referenceIndex]
            if observedIndex > 0, referenceIndex > 0 {
                let substitutionCost: UInt16 =
                    observedPhones[observedIndex - 1]
                        == reference[referenceIndex - 1].phone
                        ? 0
                        : 1
                let diagonal =
                    costs[
                        (observedIndex - 1) * rowWidth
                            + referenceIndex - 1
                    ] + substitutionCost
                if current == diagonal {
                    reversed.append(
                        .paired(
                            observedPhone:
                                observedPhones[observedIndex - 1],
                            referenceIndex: referenceIndex - 1
                        )
                    )
                    observedIndex -= 1
                    referenceIndex -= 1
                    continue
                }
            }
            if observedIndex > 0 {
                let insertion =
                    costs[
                        (observedIndex - 1) * rowWidth
                            + referenceIndex
                    ] + 1
                if current == insertion {
                    reversed.append(
                        .inserted(
                            observedPhone:
                                observedPhones[observedIndex - 1]
                        )
                    )
                    observedIndex -= 1
                    continue
                }
            }
            precondition(referenceIndex > 0)
            reversed.append(
                .deleted(referenceIndex: referenceIndex - 1)
            )
            referenceIndex -= 1
        }

        return reversed.reversed()
    }

    private static func nextReferenceAnchorByStep(
        _ steps: [AlignmentStep],
        reference: [ReferencePhone]
    ) -> [ReferenceAnchor?] {
        var result = Array<ReferenceAnchor?>(
            repeating: nil,
            count: steps.count
        )
        var nextAnchor: ReferenceAnchor?
        for stepIndex in steps.indices.reversed() {
            if let referenceIndex =
                steps[stepIndex].referenceIndex
            {
                nextAnchor = ReferenceAnchor(
                    wordIndex:
                        reference[referenceIndex].wordIndex,
                    stepIndex: stepIndex
                )
            }
            result[stepIndex] = nextAnchor
        }
        return result
    }

    private static func nearestAnchor(
        to stepIndex: Int,
        previous: ReferenceAnchor?,
        next: ReferenceAnchor?
    ) -> ReferenceAnchor? {
        switch (previous, next) {
        case (nil, nil):
            nil
        case (let previous?, nil):
            previous
        case (nil, let next?):
            next
        case (let previous?, let next?):
            stepIndex - previous.stepIndex
                <= next.stepIndex - stepIndex
                ? previous
                : next
        }
    }
}
