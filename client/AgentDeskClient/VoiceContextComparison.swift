import Foundation

// Pure comparison of two transcription readings of the SAME recorded utterance:
// one with no contextual hint, one with the target phrase seeded into the
// recognizer's context.
//
// The gap between the readings is an experimental recognition signal. Contextual
// strings bias recognition vocabulary; they do not measure pronunciation quality
// or prove why a particular transcript changed.
//
// This file is intentionally dependency-free (Foundation only, no AVFoundation,
// no Speech, no UIKit) so it compiles into the test target directly — the repo
// tests production code via dual target membership, not @testable linkage
// (see ControlSurface.swift).

/// One recognition candidate, preserving the confidence attached to that
/// candidate rather than keeping a parallel array that can drift out of order.
struct VoiceRecognitionCandidate: Codable, Equatable {
    let text: String
    /// Mean per-token confidence, or nil when the candidate did not report it.
    let confidence: Double?
}

/// One transcription pass over a recorded utterance.
struct VoiceReading: Codable, Equatable {
    /// The recognizer's best transcription.
    let top: VoiceRecognitionCandidate
    /// N-best alternatives, best-first. Empty when the recognizer offered none.
    let alternatives: [VoiceRecognitionCandidate]
}

/// Where the intended target appeared in a recognition pass.
enum VoiceTargetMatch: String, Codable, Equatable {
    case absent
    case topResult
    case alternative
}

/// How the two readings relate to the target phrase.
enum VoiceGapVerdict: String, Codable, Equatable {
    /// The target appeared in both recognition passes.
    case clear
    /// The target appeared only in the context-biased recognition pass.
    case contextRescued
    /// The target did not appear in either recognition pass.
    case missed
    /// Recognized without context but lost with it. Should be rare; reported
    /// rather than folded into another case so a misbehaving context pass stays
    /// visible instead of masquerading as a stable recognition result.
    case inconsistent
}

enum VoiceContextComparison {
    /// Lowercased, punctuation-stripped, whitespace-collapsed.
    ///
    /// Recognition output carries casing and punctuation that say nothing about
    /// whether the learner produced the target words, and comparing raw strings
    /// would report a gap for "Think." vs "think".
    static func normalize(_ text: String) -> String {
        let stripped = text.unicodeScalars
            .map { CharacterSet.punctuationCharacters.contains($0) ? " " : Character($0) }
        return String(stripped)
            .lowercased()
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    /// True when the reading contains the target's word sequence.
    ///
    /// Containment rather than equality: the recognizer may prepend or append
    /// filler around a short practice phrase, and that is not a pronunciation
    /// mismatch. Both sides are normalized, and the target is matched on word
    /// boundaries so "ink" does not match inside "think".
    static func matches(_ text: String, target: String) -> Bool {
        let normalizedTarget = normalize(target)
        guard !normalizedTarget.isEmpty else { return false }
        let targetWords = normalizedTarget.split(separator: " ")
        let textWords = normalize(text).split(separator: " ")
        guard textWords.count >= targetWords.count else { return false }
        for start in 0...(textWords.count - targetWords.count)
        where Array(textWords[start..<(start + targetWords.count)]) == Array(targetWords) {
            return true
        }
        return false
    }

    /// Reports where the target appears in the reading. The best transcription
    /// is checked first, then the alternatives: a target sitting in second place
    /// is materially different from the target being absent from the whole
    /// N-best result.
    static func matchLocation(
        in reading: VoiceReading,
        target: String
    ) -> VoiceTargetMatch {
        if matches(reading.top.text, target: target) { return .topResult }
        if reading.alternatives.contains(where: { matches($0.text, target: target) }) {
            return .alternative
        }
        return .absent
    }

    static func verdict(
        target: String,
        withoutContext: VoiceReading,
        withContext: VoiceReading
    ) -> VoiceGapVerdict {
        let unaided = matchLocation(in: withoutContext, target: target) != .absent
        let aided = matchLocation(in: withContext, target: target) != .absent
        switch (unaided, aided) {
        case (true, true): return .clear
        case (false, true): return .contextRescued
        case (false, false): return .missed
        case (true, false): return .inconsistent
        }
    }

    /// What the utterance was confusable with: everything the unaided pass
    /// offered that is not the target.
    ///
    /// This is the gap expressed in words the learner already understands —
    /// "it heard 'sink'" lands harder than a distance score. Order is preserved
    /// (best-first) and duplicates are dropped.
    static func confusions(target: String, reading: VoiceReading) -> [String] {
        var seen = Set<String>()
        return ([reading.top] + reading.alternatives).map(\.text).filter { candidate in
            let normalized = normalize(candidate)
            guard !normalized.isEmpty,
                  !matches(candidate, target: target),
                  !seen.contains(normalized) else { return false }
            seen.insert(normalized)
            return true
        }
    }
}
