import Foundation

struct VoiceMinimalPair: Equatable {
    let first: String
    let second: String

    var prompts: [String] { [first, second] }
}

enum VoiceContextMatrixRecommendation: Equatable {
    case collectMore
    case keepContextPass
    case removeContextPass
}

struct VoiceContextMatrixReport: Equatable {
    let recommendation: VoiceContextMatrixRecommendation
    let completedTakes: Int
    let requiredTakes: Int
    let promptCounts: [String: Int]
    let rankImprovements: Int
    let topResultPromotions: Int
    let regressions: Int
    let improvedPairCount: Int
}

enum VoiceContextMatrix {
    /// Contrasts that cover the current probe's intended English gaps. Two
    /// saved takes per prompt makes one accidental recognition change unable
    /// to decide the experiment by itself.
    static let minimalPairs = [
        VoiceMinimalPair(first: "think", second: "sink"),
        VoiceMinimalPair(first: "rice", second: "lice"),
        VoiceMinimalPair(first: "very", second: "wary"),
        VoiceMinimalPair(first: "ship", second: "sheep")
    ]
    static let requiredTakesPerPrompt = 2

    static func evaluate(_ attempts: [VoiceSavedAttempt]) -> VoiceContextMatrixReport {
        let prompts = minimalPairs.flatMap(\.prompts)
        let normalizedPrompts = Dictionary(
            uniqueKeysWithValues: prompts.map {
                (VoiceContextComparison.normalize($0), $0)
            }
        )

        let completed = attempts.compactMap { attempt -> (VoiceSavedAttempt, VoiceAttemptAnalysis)? in
            guard let analysis = attempt.analysis,
                  normalizedPrompts[VoiceContextComparison.normalize(attempt.targetPhrase)] != nil
            else { return nil }
            return (attempt, analysis)
        }

        var promptCounts = Dictionary(uniqueKeysWithValues: prompts.map { ($0, 0) })
        var rankImprovements = 0
        var topResultPromotions = 0
        var regressions = 0
        var improvedPairIndexes = Set<Int>()

        for (attempt, analysis) in completed {
            let normalizedTarget = VoiceContextComparison.normalize(attempt.targetPhrase)
            if let prompt = normalizedPrompts[normalizedTarget] {
                promptCounts[prompt, default: 0] += 1
            }

            let withoutRank = rank(analysis.withoutContextTargetMatch)
            let withRank = rank(analysis.withContextTargetMatch)
            if withRank > withoutRank {
                rankImprovements += 1
                if analysis.withContextTargetMatch == .topResult,
                   analysis.withoutContextTargetMatch != .topResult {
                    topResultPromotions += 1
                }
                if let pairIndex = minimalPairs.firstIndex(where: {
                    $0.prompts.contains { VoiceContextComparison.normalize($0) == normalizedTarget }
                }) {
                    improvedPairIndexes.insert(pairIndex)
                }
            } else if withRank < withoutRank {
                regressions += 1
            }
        }

        let requiredTakes = prompts.count * requiredTakesPerPrompt
        let hasCoverage = prompts.allSatisfy {
            promptCounts[$0, default: 0] >= requiredTakesPerPrompt
        }
        let recommendation: VoiceContextMatrixRecommendation
        if !hasCoverage {
            recommendation = .collectMore
        } else if topResultPromotions >= 4,
                  improvedPairIndexes.count >= 2,
                  regressions <= 1 {
            // A context pass earns its ongoing cost only when it repeatedly
            // promotes the intended target across more than one contrast and
            // rarely makes the same saved audio worse.
            recommendation = .keepContextPass
        } else {
            recommendation = .removeContextPass
        }

        return VoiceContextMatrixReport(
            recommendation: recommendation,
            completedTakes: completed.count,
            requiredTakes: requiredTakes,
            promptCounts: promptCounts,
            rankImprovements: rankImprovements,
            topResultPromotions: topResultPromotions,
            regressions: regressions,
            improvedPairCount: improvedPairIndexes.count
        )
    }

    private static func rank(_ match: VoiceTargetMatch) -> Int {
        switch match {
        case .absent: 0
        case .alternative: 1
        case .topResult: 2
        }
    }
}
