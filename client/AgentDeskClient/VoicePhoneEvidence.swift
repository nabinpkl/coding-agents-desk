import Foundation

struct VoicePhoneModelManifest: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1
    static let selectedWeightSHA256 =
        "8c093d09a94c89898670734440b18432f3229e7a9e5174f1fe3c159898fa172c"
    static let selectedSpecificationSHA256 =
        "44629ea3d97747f6d80b8ebb906b5ddfabc301bdc6f565e5ed1bb625d46f34f4"

    let schemaVersion: Int
    let identifier: String
    let upstreamModel: String
    let upstreamLicense: String
    let conversionRepository: String
    let conversionRevision: String
    let conversionID: String
    let sourceWeightSHA256: String
    let modelWeightSHA256: String
    let modelSpecificationSHA256: String
    let vocabularySHA256: String
    let modelBytes: Int
    let minimumIOSVersion: Int
    let sampleRate: Int
    let sampleCount: Int
    let frameCount: Int
    let vocabularySize: Int
    let blankTokenID: Int
}

struct VoiceTargetPronunciation: Codable, Equatable, Sendable {
    let word: String
    let source: String
    let sourceRevision: String
    let arpabet: [String]
    let phones: [String]
}

struct VoicePhoneHypothesis: Codable, Equatable, Sendable {
    let tokenID: Int
    let phone: String
    let logPosterior: Double
}

struct VoicePhoneFrameEvidence: Codable, Equatable, Sendable {
    let startSeconds: TimeInterval
    let endSeconds: TimeInterval
    let hypotheses: [VoicePhoneHypothesis]
}

struct VoiceAlignedPhoneEvidence: Codable, Equatable, Sendable {
    let targetPhone: String
    let startSeconds: TimeInterval
    let endSeconds: TimeInterval
    let targetLogPosterior: Double
    let observedPhone: VoicePhoneHypothesis
    let competingPhones: [VoicePhoneHypothesis]
    let posteriorMargin: Double
    let scoreFeatures: VoicePhoneScoreFeatures
}

struct VoicePhoneScoreFeatures: Codable, Equatable, Sendable {
    static let currentVersion = "r131-v1"

    let featureVersion: String
    let alignedTargetMeanLogit: Double
    let alignedStrongestCompetitorMeanLogit: Double
    let alignedLogitMargin: Double
    let canonicalSequenceLogProbability: Double
    let substitutionSequenceLogSumProbability: Double
    let deletionSequenceLogProbability: Double
    let alignmentFreeSubstitutionMargin: Double
    let alignmentFreeSubstitutionDeletionMargin: Double
    let blankFrameRatio: Double
    let effectiveNonBlankFrameCount: Int
}

struct VoicePhoneInferenceMetrics: Codable, Equatable, Sendable {
    let sourceDurationSeconds: TimeInterval
    let analyzedOffsetSeconds: TimeInterval
    let analyzedDurationSeconds: TimeInterval
    let preprocessingMilliseconds: Double
    let modelLoadMilliseconds: Double
    let inferenceMilliseconds: Double
    let observedResidentMemoryDeltaBytes: UInt64?
    let peakAbsoluteSample: Double
    let clippedSampleRatio: Double
}

struct VoicePhoneEvidence: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 2

    let schemaVersion: Int
    let attemptID: UUID
    let createdAt: Date
    let audioSHA256: String
    let localeIdentifier: String
    let model: VoicePhoneModelManifest
    let pronunciation: VoiceTargetPronunciation
    let frames: [VoicePhoneFrameEvidence]
    let alignedPhones: [VoiceAlignedPhoneEvidence]
    let metrics: VoicePhoneInferenceMetrics
}

struct VoiceStoredPhoneAnalysis: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 2

    let schemaVersion: Int
    let attemptID: UUID
    let updatedAt: Date
    let audioSHA256: String
    let modelWeightSHA256: String?
    let evidence: VoicePhoneEvidence?
    let failure: String?

    static func completed(_ evidence: VoicePhoneEvidence) -> VoiceStoredPhoneAnalysis {
        VoiceStoredPhoneAnalysis(
            schemaVersion: currentSchemaVersion,
            attemptID: evidence.attemptID,
            updatedAt: evidence.createdAt,
            audioSHA256: evidence.audioSHA256,
            modelWeightSHA256: evidence.model.modelWeightSHA256,
            evidence: evidence,
            failure: nil
        )
    }

    static func failed(
        attemptID: UUID,
        audioSHA256: String,
        modelWeightSHA256: String?,
        message: String,
        updatedAt: Date = Date()
    ) -> VoiceStoredPhoneAnalysis {
        VoiceStoredPhoneAnalysis(
            schemaVersion: currentSchemaVersion,
            attemptID: attemptID,
            updatedAt: updatedAt,
            audioSHA256: audioSHA256,
            modelWeightSHA256: modelWeightSHA256,
            evidence: nil,
            failure: message
        )
    }

    var isWellFormed: Bool {
        guard schemaVersion == Self.currentSchemaVersion,
              (evidence == nil) != (failure == nil)
        else {
            return false
        }
        if let evidence {
            return evidence.schemaVersion == VoicePhoneEvidence.currentSchemaVersion
                && evidence.attemptID == attemptID
                && evidence.audioSHA256 == audioSHA256
                && evidence.model.modelWeightSHA256 == modelWeightSHA256
        }
        return failure?.isEmpty == false
    }
}
