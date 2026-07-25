import Foundation

enum VoiceCTCAlignmentError: LocalizedError, Equatable {
    case emptyLogits
    case inconsistentVocabularySize
    case invalidTargetToken(Int)
    case noAlignment

    var errorDescription: String? {
        switch self {
        case .emptyLogits:
            return "The phone model returned no frames."
        case .inconsistentVocabularySize:
            return "The phone model returned inconsistent vocabulary dimensions."
        case .invalidTargetToken(let token):
            return "Target phone token \(token) is outside the model vocabulary."
        case .noAlignment:
            return "The target pronunciation could not be aligned to the recording."
        }
    }
}

struct VoiceCTCAlignmentResult: Equatable, Sendable {
    let score: Double
    let tokenFrameRanges: [ClosedRange<Int>]
}

enum VoiceCTCAlignment {
    static func logPosteriors(logits: [[Float]]) throws -> [[Double]] {
        guard let first = logits.first, !first.isEmpty else {
            throw VoiceCTCAlignmentError.emptyLogits
        }
        guard logits.allSatisfy({ $0.count == first.count }) else {
            throw VoiceCTCAlignmentError.inconsistentVocabularySize
        }
        return logits.map { frame in
            let maximum = Double(frame.max()!)
            let denominator = frame.reduce(0.0) {
                $0 + Foundation.exp(Double($1) - maximum)
            }
            let logDenominator = Foundation.log(denominator)
            return frame.map { Double($0) - maximum - logDenominator }
        }
    }

    static func greedyTokens(
        logPosteriors: [[Double]],
        blankTokenID: Int
    ) -> [Int] {
        var result: [Int] = []
        var previous: Int?
        for frame in logPosteriors {
            guard let winner = frame.indices.max(by: { frame[$0] < frame[$1] }) else {
                continue
            }
            if winner != blankTokenID, winner != previous {
                result.append(winner)
            }
            previous = winner
        }
        return result
    }

    static func align(
        logPosteriors: [[Double]],
        targetTokenIDs: [Int],
        blankTokenID: Int
    ) throws -> VoiceCTCAlignmentResult {
        guard let vocabularySize = logPosteriors.first?.count,
              !logPosteriors.isEmpty,
              !targetTokenIDs.isEmpty
        else {
            throw VoiceCTCAlignmentError.emptyLogits
        }
        guard logPosteriors.allSatisfy({ $0.count == vocabularySize }) else {
            throw VoiceCTCAlignmentError.inconsistentVocabularySize
        }
        for token in targetTokenIDs where token < 0 || token >= vocabularySize {
            throw VoiceCTCAlignmentError.invalidTargetToken(token)
        }

        var states = [blankTokenID]
        for token in targetTokenIDs {
            states.append(token)
            states.append(blankTokenID)
        }
        let frameCount = logPosteriors.count
        let stateCount = states.count
        var scores = Array(
            repeating: Array(repeating: -Double.infinity, count: stateCount),
            count: frameCount
        )
        var previousStates = Array(
            repeating: Array(repeating: -1, count: stateCount),
            count: frameCount
        )
        scores[0][0] = logPosteriors[0][blankTokenID]
        if stateCount > 1 {
            scores[0][1] = logPosteriors[0][states[1]]
        }

        if frameCount > 1 {
            for frameIndex in 1..<frameCount {
                for stateIndex in 0..<stateCount {
                    var candidates = [(scores[frameIndex - 1][stateIndex], stateIndex)]
                    if stateIndex > 0 {
                        candidates.append((
                            scores[frameIndex - 1][stateIndex - 1],
                            stateIndex - 1
                        ))
                    }
                    if stateIndex > 1,
                       states[stateIndex] != blankTokenID,
                       states[stateIndex] != states[stateIndex - 2] {
                        candidates.append((
                            scores[frameIndex - 1][stateIndex - 2],
                            stateIndex - 2
                        ))
                    }
                    let best = candidates.max { $0.0 < $1.0 }!
                    scores[frameIndex][stateIndex] =
                        best.0 + logPosteriors[frameIndex][states[stateIndex]]
                    previousStates[frameIndex][stateIndex] = best.1
                }
            }
        }

        let finalCandidates = [
            (scores[frameCount - 1][stateCount - 1], stateCount - 1),
            (scores[frameCount - 1][max(0, stateCount - 2)], max(0, stateCount - 2))
        ]
        guard let final = finalCandidates.max(by: { $0.0 < $1.0 }),
              final.0.isFinite
        else {
            throw VoiceCTCAlignmentError.noAlignment
        }

        var path = Array(repeating: 0, count: frameCount)
        var stateIndex = final.1
        for frameIndex in stride(from: frameCount - 1, through: 0, by: -1) {
            path[frameIndex] = stateIndex
            if frameIndex > 0 {
                stateIndex = previousStates[frameIndex][stateIndex]
                guard stateIndex >= 0 else {
                    throw VoiceCTCAlignmentError.noAlignment
                }
            }
        }

        let ranges = try targetTokenIDs.indices.map { targetIndex in
            let targetState = targetIndex * 2 + 1
            let matchingFrames = path.indices.filter { path[$0] == targetState }
            guard let first = matchingFrames.first, let last = matchingFrames.last else {
                throw VoiceCTCAlignmentError.noAlignment
            }
            return first...last
        }
        return VoiceCTCAlignmentResult(score: final.0, tokenFrameRanges: ranges)
    }

    static func topHypotheses(
        frame: [Double],
        vocabulary: [Int: String],
        limit: Int,
        excludingTokenIDs: Set<Int> = []
    ) -> [VoicePhoneHypothesis] {
        frame.indices
            .filter {
                !excludingTokenIDs.contains($0)
                    && !(vocabulary[$0]?.hasPrefix("<") ?? true)
            }
            .sorted { frame[$0] > frame[$1] }
            .prefix(limit)
            .map {
                VoicePhoneHypothesis(
                    tokenID: $0,
                    phone: vocabulary[$0]!,
                    logPosterior: frame[$0]
                )
            }
    }
}
