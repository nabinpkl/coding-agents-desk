import CoreVideo
import Foundation

struct ScrollDeltaSurface {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let pixels: Data
}

struct ScrollDeltaOffset {
    let dx: Int
    let dy: Int
}

struct ScrollDeltaProbeOutcome {
    let offset: ScrollDeltaOffset?
    let bestDx: Int?
    let bestDy: Int?
    let confidence: Double
    let secondBestConfidence: Double
    let sampledPixelCount: Int
    let candidateCount: Int
    let timedOut: Bool
    let timeoutReason: String?
    let timeoutPhase: String?
    let probeScale: Int
    let hintCandidates: [Int]
    let tieBreak: String?
}

struct ScrollDeltaMatchScore {
    let confidence: Double
    let samples: Int
}

private struct ScrollDeltaHintScore {
    let offset: ScrollDeltaOffset
    let scalar: Int
    let confidence: Double
    let samples: Int
}

struct ScrollDeltaDirectBGRASampler {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let baseAddress: UnsafeRawPointer
}

struct ScrollDeltaDirectLumaSampler {
    let width: Int
    let height: Int
    let bytesPerRow: Int
    let baseAddress: UnsafeRawPointer
}

struct ScrollDeltaSurfaceSampler {
    let surface: ScrollDeltaSurface

    var width: Int { surface.width }
    var height: Int { surface.height }
}

enum ScrollDeltaProbeSampler {
    case bgra(ScrollDeltaDirectBGRASampler)
    case luma(ScrollDeltaDirectLumaSampler)
    case surface(ScrollDeltaSurfaceSampler)

    var width: Int {
        switch self {
        case .bgra(let sampler): sampler.width
        case .luma(let sampler): sampler.width
        case .surface(let sampler): sampler.width
        }
    }

    var height: Int {
        switch self {
        case .bgra(let sampler): sampler.height
        case .luma(let sampler): sampler.height
        case .surface(let sampler): sampler.height
        }
    }
}

struct ScrollDeltaProbe {
    private static let targetSampleColumns = 10
    private static let targetSampleRows = 8
    private static let verificationSampleColumns = 48
    private static let verificationSampleRows = 28
    private static let lumaTolerance = 24
    private static let rgbTolerance = 0

    let previous: ScrollDeltaSurface
    let sampler: ScrollDeltaProbeSampler
    let maxScrollOffset: Int
    let confidenceThreshold: Double
    let confidenceMargin: Double
    let startedAt: UInt64
    let detectionBudgetMs: Double
    let elapsedMs: (UInt64) -> Double
    let region: ScrollRegion?

    func bestOffset(scrollHint: ScrollActivityHint? = nil) -> ScrollDeltaProbeOutcome {
        if detectionBudgetMs <= 0 {
            return outcome(
                offset: nil,
                bestOffset: nil,
                confidence: 0,
                secondBestConfidence: 0,
                sampledPixelCount: 0,
                candidateCount: 0,
                timedOut: true,
                timeoutReason: "probe-budget-exceeded",
                timeoutPhase: "candidate-scan",
                probeScale: 1
            )
        }
        if let scrollHint, scrollHint.isActive(nowUptimeNs: startedAt) {
            return bestHintOffset(scrollHint)
        }
        let sampleXs = sampleCoordinates(axisLength: .x, targetCount: Self.targetSampleColumns)
        let sampleYs = sampleCoordinates(axisLength: .y, targetCount: Self.targetSampleRows)
        guard !sampleXs.isEmpty, !sampleYs.isEmpty else {
            return outcome(
                offset: nil,
                bestOffset: nil,
                confidence: 0,
                secondBestConfidence: 0,
                sampledPixelCount: 0,
                candidateCount: 0,
                timedOut: false,
                timeoutReason: "no-probe-samples",
                timeoutPhase: nil,
                probeScale: 1
            )
        }
        var bestOffset: ScrollDeltaOffset?
        var bestScore = 0.0
        var secondBestScore = 0.0
        var sampledPixelCount = 0
        var candidateCount = 0
        let probeScale = max(1, min(previous.width, previous.height) / max(sampleXs.count, sampleYs.count))

        for offset in -maxScrollOffset...maxScrollOffset where offset != 0 {
            let score = verticalScore(offset: offset, sampleXs: sampleXs, sampleYs: sampleYs)
            let selectedScore = selectionScore(confidence: score.confidence, dx: 0, dy: offset)
            candidateCount += 1
            sampledPixelCount += score.samples
            if selectedScore > bestScore {
                secondBestScore = bestScore
                bestScore = selectedScore
                bestOffset = ScrollDeltaOffset(dx: 0, dy: offset)
            } else if selectedScore > secondBestScore {
                secondBestScore = selectedScore
            }
        }
        if let verticalBest = bestOffset, verticalBest.dx == 0 {
            let verificationXs = sampleCoordinates(
                axisLength: .x,
                targetCount: Self.verificationSampleColumns
            )
            let verificationYs = sampleCoordinates(
                axisLength: .y,
                targetCount: Self.verificationSampleRows
            )
            let refined = refine(
                around: verticalBest,
                radius: 4,
                sampleXs: verificationXs,
                sampleYs: verificationYs
            )
            if refined.timedOut {
                sampledPixelCount += refined.samples
            }
            if !refined.timedOut {
                sampledPixelCount += refined.samples
                bestOffset = refined.offset
                bestScore = refined.confidence
                secondBestScore = refined.secondBestConfidence
            }
            if isAccepted(confidence: bestScore, secondBestConfidence: secondBestScore) {
                return outcome(
                    offset: bestOffset,
                    bestOffset: bestOffset,
                    confidence: bestScore,
                    secondBestConfidence: secondBestScore,
                    sampledPixelCount: sampledPixelCount,
                    candidateCount: candidateCount,
                    timedOut: false,
                    timeoutReason: nil,
                    timeoutPhase: nil,
                    probeScale: probeScale
                )
            }
        }
        for offset in -maxScrollOffset...maxScrollOffset where offset != 0 {
            let score = horizontalScore(offset: offset, sampleXs: sampleXs, sampleYs: sampleYs)
            let selectedScore = selectionScore(confidence: score.confidence, dx: offset, dy: 0)
            candidateCount += 1
            sampledPixelCount += score.samples
            if selectedScore > bestScore {
                secondBestScore = bestScore
                bestScore = selectedScore
                bestOffset = ScrollDeltaOffset(dx: offset, dy: 0)
            } else if selectedScore > secondBestScore {
                secondBestScore = selectedScore
            }
        }

        if let coarseBestOffset = bestOffset {
            let verificationXs = sampleCoordinates(
                axisLength: .x,
                targetCount: Self.verificationSampleColumns
            )
            let verificationYs = sampleCoordinates(
                axisLength: .y,
                targetCount: Self.verificationSampleRows
            )
            let refined = refine(
                around: coarseBestOffset,
                radius: 4,
                sampleXs: verificationXs,
                sampleYs: verificationYs
            )
            if refined.timedOut {
                sampledPixelCount += refined.samples
            } else {
                bestOffset = refined.offset
                sampledPixelCount += refined.samples
                bestScore = refined.confidence
                secondBestScore = refined.secondBestConfidence
            }
        }

        let accepted = isAccepted(confidence: bestScore, secondBestConfidence: secondBestScore)
        let timedOut = !accepted && bestScore > 0 && isOverBudget
        return outcome(
            offset: accepted ? bestOffset : nil,
            bestOffset: bestOffset,
            confidence: bestScore,
            secondBestConfidence: secondBestScore,
            sampledPixelCount: sampledPixelCount,
            candidateCount: candidateCount,
            timedOut: timedOut,
            timeoutReason: timedOut ? "probe-budget-exceeded" : nil,
            timeoutPhase: timedOut ? "candidate-scan" : nil,
            probeScale: probeScale
        )
    }

    private func bestHintOffset(_ hint: ScrollActivityHint) -> ScrollDeltaProbeOutcome {
        let sampleXs = sampleCoordinates(
            axisLength: .x,
            targetCount: Self.verificationSampleColumns
        )
        let sampleYs = sampleCoordinates(
            axisLength: .y,
            targetCount: Self.verificationSampleRows
        )
        guard !sampleXs.isEmpty, !sampleYs.isEmpty else {
            return outcome(
                offset: nil,
                bestOffset: nil,
                confidence: 0,
                secondBestConfidence: 0,
                sampledPixelCount: 0,
                candidateCount: 0,
                timedOut: false,
                timeoutReason: "no-probe-samples",
                timeoutPhase: nil,
                probeScale: 1
            )
        }
        let candidates = hintCandidateOffsets(from: hint)
        guard !candidates.isEmpty else {
            return outcome(
                offset: nil,
                bestOffset: nil,
                confidence: 0,
                secondBestConfidence: 0,
                sampledPixelCount: 0,
                candidateCount: 0,
                timedOut: false,
                timeoutReason: "no-hint-candidates",
                timeoutPhase: nil,
                probeScale: 1,
                hintCandidates: candidates
            )
        }

        var scores: [ScrollDeltaHintScore] = []
        var sampledPixelCount = 0
        for candidate in candidates {
            let score = hint.axis == .vertical
                ? verticalScore(offset: candidate, sampleXs: sampleXs, sampleYs: sampleYs)
                : horizontalScore(offset: candidate, sampleXs: sampleXs, sampleYs: sampleYs)
            sampledPixelCount += score.samples
            scores.append(ScrollDeltaHintScore(
                offset: hint.axis == .vertical
                    ? ScrollDeltaOffset(dx: 0, dy: candidate)
                    : ScrollDeltaOffset(dx: candidate, dy: 0),
                scalar: candidate,
                confidence: score.confidence,
                samples: score.samples
            ))
        }
        guard let rawBest = scores.max(by: { lhs, rhs in lhs.confidence < rhs.confidence }) else {
            return outcome(
                offset: nil,
                bestOffset: nil,
                confidence: 0,
                secondBestConfidence: 0,
                sampledPixelCount: sampledPixelCount,
                candidateCount: candidates.count,
                timedOut: false,
                timeoutReason: "no-hint-candidates",
                timeoutPhase: nil,
                probeScale: 1,
                hintCandidates: candidates
            )
        }

        var best = rawBest
        var tieBreak: String?
        let nearMatches = scores.filter { candidate in
            candidate.scalar != rawBest.scalar &&
                candidate.confidence >= confidenceThreshold &&
                rawBest.confidence - candidate.confidence <= confidenceMargin
        }
        if !nearMatches.isEmpty {
            let predicted = hint.predictedOffsetPx
            let tied = ([rawBest] + nearMatches).min { lhs, rhs in
                let lhsDistance = abs(lhs.scalar - predicted)
                let rhsDistance = abs(rhs.scalar - predicted)
                if lhsDistance != rhsDistance {
                    return lhsDistance < rhsDistance
                }
                return lhs.confidence > rhs.confidence
            }
            if let tied {
                best = tied
                tieBreak = "predicted-offset"
            }
        }

        let zeroMotionScore = hint.axis == .vertical
            ? verticalScore(offset: 0, sampleXs: sampleXs, sampleYs: sampleYs)
            : horizontalScore(offset: 0, sampleXs: sampleXs, sampleYs: sampleYs)
        sampledPixelCount += zeroMotionScore.samples
        if zeroMotionScore.confidence >= confidenceThreshold &&
            abs(best.confidence - zeroMotionScore.confidence) <= 0.001 {
            let probeScale = max(1, min(previous.width, previous.height) / max(sampleXs.count, sampleYs.count))
            return outcome(
                offset: nil,
                bestOffset: best.offset,
                confidence: best.confidence,
                secondBestConfidence: max(secondBest(scores: scores, excluding: best.scalar), zeroMotionScore.confidence),
                sampledPixelCount: sampledPixelCount,
                candidateCount: candidates.count,
                timedOut: false,
                timeoutReason: "hint-zero-motion-ambiguous",
                timeoutPhase: nil,
                probeScale: probeScale,
                hintCandidates: candidates,
                tieBreak: tieBreak
            )
        }

        let secondBestConfidence = scores
            .filter { $0.scalar != best.scalar }
            .map(\.confidence)
            .max() ?? 0
        let accepted = best.confidence >= confidenceThreshold
        let timedOut = !accepted && best.confidence > 0 && isOverBudget
        let probeScale = max(1, min(previous.width, previous.height) / max(sampleXs.count, sampleYs.count))
        return outcome(
            offset: accepted ? best.offset : nil,
            bestOffset: best.offset,
            confidence: best.confidence,
            secondBestConfidence: secondBestConfidence,
            sampledPixelCount: sampledPixelCount,
            candidateCount: candidates.count,
            timedOut: timedOut,
            timeoutReason: timedOut ? "probe-budget-exceeded" : nil,
            timeoutPhase: timedOut ? "hint-candidate-scan" : nil,
            probeScale: probeScale,
            hintCandidates: candidates,
            tieBreak: tieBreak
        )
    }

    private func secondBest(scores: [ScrollDeltaHintScore], excluding scalar: Int) -> Double {
        scores
            .filter { $0.scalar != scalar }
            .map(\.confidence)
            .max() ?? 0
    }

    private func hintCandidateOffsets(from hint: ScrollActivityHint) -> [Int] {
        let sign = hint.sign < 0 ? -1 : 1
        var seen = Set<Int>()
        var candidates: [Int] = []
        for candidate in hint.candidateOffsets {
            guard candidate != 0,
                  abs(candidate) <= maxScrollOffset,
                  (candidate < 0 ? -1 : 1) == sign else {
                continue
            }
            if seen.insert(candidate).inserted {
                candidates.append(candidate)
                if candidates.count == 24 {
                    break
                }
            }
        }
        return candidates
    }

    private var isOverBudget: Bool {
        elapsedMs(startedAt) > detectionBudgetMs
    }

    private func isAccepted(confidence: Double, secondBestConfidence: Double) -> Bool {
        confidence >= confidenceThreshold && confidence - secondBestConfidence >= confidenceMargin
    }

    private enum ProbeAxis {
        case x
        case y
    }

    private func sampleCoordinates(axisLength axis: ProbeAxis, targetCount: Int) -> [Int] {
        let start: Int
        let length: Int
        switch axis {
        case .x:
            start = region?.x ?? 0
            length = region.map { min($0.width, previous.width - $0.x, sampler.width - $0.x) } ?? min(previous.width, sampler.width)
        case .y:
            start = region?.y ?? 0
            length = region.map { min($0.height, previous.height - $0.y, sampler.height - $0.y) } ?? min(previous.height, sampler.height)
        }
        guard length > 0, targetCount > 0 else { return [] }
        let count = min(length, targetCount)
        guard count > 1 else { return [start + length / 2] }
        return (0..<count).map { index in
            start + min(length - 1, (index * (length - 1)) / (count - 1))
        }
    }

    private func verticalScore(offset: Int, sampleXs: [Int], sampleYs: [Int]) -> ScrollDeltaMatchScore {
        var matches = 0
        var samples = 0
        for currentY in sampleYs {
            let previousY = currentY - offset
            guard previousY >= 0, previousY < previous.height, currentY < sampler.height else { continue }
            for x in sampleXs where x < previous.width && x < sampler.width {
                if let region {
                    guard x >= region.x,
                          x < region.maxX,
                          currentY >= region.y,
                          currentY < region.maxY,
                          previousY >= region.y,
                          previousY < region.maxY else {
                        continue
                    }
                }
                if samplesMatch(previousX: x, previousY: previousY, currentX: x, currentY: currentY) {
                    matches += 1
                }
                samples += 1
            }
        }
        guard samples > 0 else { return ScrollDeltaMatchScore(confidence: 0, samples: 0) }
        return ScrollDeltaMatchScore(confidence: Double(matches) / Double(samples), samples: samples)
    }

    private func horizontalScore(offset: Int, sampleXs: [Int], sampleYs: [Int]) -> ScrollDeltaMatchScore {
        var matches = 0
        var samples = 0
        for y in sampleYs where y < previous.height && y < sampler.height {
            if let region {
                guard y >= region.y, y < region.maxY else { continue }
            }
            for currentX in sampleXs {
                let previousX = currentX - offset
                guard previousX >= 0, previousX < previous.width, currentX < sampler.width else { continue }
                if let region {
                    guard currentX >= region.x,
                          currentX < region.maxX,
                          previousX >= region.x,
                          previousX < region.maxX else {
                        continue
                    }
                }
                if samplesMatch(previousX: previousX, previousY: y, currentX: currentX, currentY: y) {
                    matches += 1
                }
                samples += 1
            }
        }
        guard samples > 0 else { return ScrollDeltaMatchScore(confidence: 0, samples: 0) }
        return ScrollDeltaMatchScore(confidence: Double(matches) / Double(samples), samples: samples)
    }

    private func refine(
        around offset: ScrollDeltaOffset,
        radius: Int,
        sampleXs: [Int],
        sampleYs: [Int]
    ) -> (offset: ScrollDeltaOffset?, confidence: Double, secondBestConfidence: Double, samples: Int, timedOut: Bool) {
        var refinedOffset: ScrollDeltaOffset?
        var refinedConfidence = 0.0
        var refinedSelectionScore = 0.0
        var secondBestConfidence = 0.0
        var samples = 0
        let lowerBound = max(-maxScrollOffset, scalarOffset(offset) - radius)
        let upperBound = min(maxScrollOffset, scalarOffset(offset) + radius)
        let offsets = lowerBound...upperBound
        for candidate in offsets where candidate != 0 {
            let score = offset.dx == 0
                ? verticalScore(offset: candidate, sampleXs: sampleXs, sampleYs: sampleYs)
                : horizontalScore(offset: candidate, sampleXs: sampleXs, sampleYs: sampleYs)
            samples += score.samples
            let selection = offset.dx == 0
                ? selectionScore(confidence: score.confidence, dx: 0, dy: candidate)
                : selectionScore(confidence: score.confidence, dx: candidate, dy: 0)
            if selection > refinedSelectionScore {
                secondBestConfidence = refinedConfidence
                refinedSelectionScore = selection
                refinedConfidence = score.confidence
                refinedOffset = offset.dx == 0
                    ? ScrollDeltaOffset(dx: 0, dy: candidate)
                    : ScrollDeltaOffset(dx: candidate, dy: 0)
            } else if score.confidence > secondBestConfidence {
                secondBestConfidence = score.confidence
            }
        }
        return (refinedOffset, refinedConfidence, secondBestConfidence, samples, false)
    }

    private func scalarOffset(_ offset: ScrollDeltaOffset) -> Int {
        offset.dx == 0 ? offset.dy : offset.dx
    }

    private func selectionScore(confidence: Double, dx: Int, dy: Int) -> Double {
        let overlapWidth = Double(max(0, sampler.width - abs(dx)))
        let overlapHeight = Double(max(0, sampler.height - abs(dy)))
        let total = Double(max(1, sampler.width * sampler.height))
        return confidence * ((overlapWidth * overlapHeight) / total)
    }

    private func samplesMatch(previousX: Int, previousY: Int, currentX: Int, currentY: Int) -> Bool {
        switch sampler {
        case .luma:
            return abs(
                Int(previousLuma(x: previousX, y: previousY)) -
                    Int(currentLuma(x: currentX, y: currentY))
            ) <= Self.lumaTolerance
        case .bgra, .surface:
            let previous = previousRGB(x: previousX, y: previousY)
            let current = currentRGB(x: currentX, y: currentY)
            return abs(Int(previous.red) - Int(current.red)) <= Self.rgbTolerance &&
                abs(Int(previous.green) - Int(current.green)) <= Self.rgbTolerance &&
                abs(Int(previous.blue) - Int(current.blue)) <= Self.rgbTolerance
        }
    }

    private func previousRGB(x: Int, y: Int) -> (red: UInt8, green: UInt8, blue: UInt8) {
        let index = y * previous.bytesPerRow + x * 4
        return (
            red: previous.pixels[index + 2],
            green: previous.pixels[index + 1],
            blue: previous.pixels[index]
        )
    }

    private func previousLuma(x: Int, y: Int) -> UInt8 {
        let rgb = previousRGB(x: x, y: y)
        let blue = 29 * Int(rgb.blue)
        let green = 150 * Int(rgb.green)
        let red = 77 * Int(rgb.red)
        return UInt8((blue + green + red) >> 8)
    }

    private func currentRGB(x: Int, y: Int) -> (red: UInt8, green: UInt8, blue: UInt8) {
        switch sampler {
        case .bgra(let sampler):
            let offset = y * sampler.bytesPerRow + x * 4
            return (
                red: sampler.baseAddress.load(fromByteOffset: offset + 2, as: UInt8.self),
                green: sampler.baseAddress.load(fromByteOffset: offset + 1, as: UInt8.self),
                blue: sampler.baseAddress.load(fromByteOffset: offset, as: UInt8.self)
            )
        case .luma:
            let luma = currentLuma(x: x, y: y)
            return (red: luma, green: luma, blue: luma)
        case .surface(let sampler):
            let index = y * sampler.surface.bytesPerRow + x * 4
            return (
                red: sampler.surface.pixels[index + 2],
                green: sampler.surface.pixels[index + 1],
                blue: sampler.surface.pixels[index]
            )
        }
    }

    private func currentLuma(x: Int, y: Int) -> UInt8 {
        switch sampler {
        case .bgra(let sampler):
            let offset = y * sampler.bytesPerRow + x * 4
            let blue = 29 * Int(sampler.baseAddress.load(fromByteOffset: offset, as: UInt8.self))
            let green = 150 * Int(sampler.baseAddress.load(fromByteOffset: offset + 1, as: UInt8.self))
            let red = 77 * Int(sampler.baseAddress.load(fromByteOffset: offset + 2, as: UInt8.self))
            return UInt8((blue + green + red) >> 8)
        case .luma(let sampler):
            return sampler.baseAddress.load(fromByteOffset: y * sampler.bytesPerRow + x, as: UInt8.self)
        case .surface(let sampler):
            let index = y * sampler.surface.bytesPerRow + x * 4
            let blue = 29 * Int(sampler.surface.pixels[index])
            let green = 150 * Int(sampler.surface.pixels[index + 1])
            let red = 77 * Int(sampler.surface.pixels[index + 2])
            return UInt8((blue + green + red) >> 8)
        }
    }

    private func outcome(
        offset: ScrollDeltaOffset?,
        bestOffset: ScrollDeltaOffset?,
        confidence: Double,
        secondBestConfidence: Double,
        sampledPixelCount: Int,
        candidateCount: Int,
        timedOut: Bool,
        timeoutReason: String?,
        timeoutPhase: String?,
        probeScale: Int,
        hintCandidates: [Int] = [],
        tieBreak: String? = nil
    ) -> ScrollDeltaProbeOutcome {
        ScrollDeltaProbeOutcome(
            offset: offset,
            bestDx: bestOffset?.dx,
            bestDy: bestOffset?.dy,
            confidence: confidence,
            secondBestConfidence: secondBestConfidence,
            sampledPixelCount: sampledPixelCount,
            candidateCount: candidateCount,
            timedOut: timedOut,
            timeoutReason: timeoutReason,
            timeoutPhase: timeoutPhase,
            probeScale: probeScale,
            hintCandidates: hintCandidates,
            tieBreak: tieBreak
        )
    }
}
