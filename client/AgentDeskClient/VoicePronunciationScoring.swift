import CryptoKit
import Foundation

enum VoicePronunciationScoreCandidate: String, Codable, CaseIterable, Sendable {
    case alignedPosteriorMargin
    case alignedLogitMargin
    case alignmentFreeSubstitutionMargin
    case alignmentFreeSubstitutionDeletionMargin
}

struct VoicePronunciationCandidateMargins: Codable, Equatable, Sendable {
    let alignedPosteriorMargin: Double
    let alignedLogitMargin: Double
    let alignmentFreeSubstitutionMargin: Double
    let alignmentFreeSubstitutionDeletionMargin: Double

    init(evidence: VoiceAlignedPhoneEvidence) {
        alignedPosteriorMargin = evidence.posteriorMargin
        alignedLogitMargin = evidence.scoreFeatures.alignedLogitMargin
        alignmentFreeSubstitutionMargin =
            evidence.scoreFeatures.alignmentFreeSubstitutionMargin
        alignmentFreeSubstitutionDeletionMargin =
            evidence.scoreFeatures.alignmentFreeSubstitutionDeletionMargin
    }

    func value(for candidate: VoicePronunciationScoreCandidate) -> Double {
        switch candidate {
        case .alignedPosteriorMargin:
            alignedPosteriorMargin
        case .alignedLogitMargin:
            alignedLogitMargin
        case .alignmentFreeSubstitutionMargin:
            alignmentFreeSubstitutionMargin
        case .alignmentFreeSubstitutionDeletionMargin:
            alignmentFreeSubstitutionDeletionMargin
        }
    }

    var values: [Double] {
        [
            alignedPosteriorMargin,
            alignedLogitMargin,
            alignmentFreeSubstitutionMargin,
            alignmentFreeSubstitutionDeletionMargin
        ]
    }
}

struct VoicePhoneCalibrationKnot: Codable, Equatable, Sendable {
    let margin: Double
    let expectedGrade: Double
}

struct VoicePhoneCalibrationMapping: Codable, Equatable, Sendable {
    /// Nil denotes the global mapping.
    let phone: String?
    let knots: [VoicePhoneCalibrationKnot]
}

struct VoicePhoneCalibrationSupport: Codable, Equatable, Sendable {
    let phone: String
    let trainingCount: Int
    let testCount: Int
    let lowGradeTrainingCount: Int
    let highGradeTrainingCount: Int
    let lowGradeTestCount: Int
    let highGradeTestCount: Int
    let testPearsonCorrelation: Double
    let testMeanAbsoluteError: Double
}

struct VoicePhoneCalibrationValidation: Codable, Equatable, Sendable {
    let testPearsonCorrelation: Double
    let testSpearmanCorrelation: Double
    let testMeanAbsoluteError: Double
    let testAUROC: Double
    let testCalibrationError: Double
    let speakerBootstrapPearsonLowerBound: Double
    let l2ArcticOverallAUROC: Double?
    let l2ArcticWorstL1AUROC: Double?
    let l2ArcticWorstRecallGap: Double?
}

struct VoicePhoneCalibrationManifest: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let identifier: String
    let generatedAt: String
    let displayEnabled: Bool
    let disabledReason: String?
    let sourceCorpus: String
    let sourceRevision: String
    let sourceSHA256: String
    let sourceLicense: String
    let sourcePopulation: String
    let localeIdentifiers: [String]
    let featureVersion: String
    let selectedCandidate: VoicePronunciationScoreCandidate
    let modelWeightSHA256: String
    let modelSpecificationSHA256: String
    let vocabularySHA256: String
    let minimumEffectiveNonBlankFrameCount: Int
    let maximumBlankFrameRatio: Double
    let maximumClippedSampleRatio: Double
    let maximumSourceDurationSeconds: Double
    let needsAttentionUpperBound: Double
    let closeUpperBound: Double
    let mappings: [VoicePhoneCalibrationMapping]
    let supportedPhones: [VoicePhoneCalibrationSupport]
    let validation: VoicePhoneCalibrationValidation?

    var contentSHA256: String? {
        VoicePronunciationHashing.sha256(self)
    }
}

enum VoicePhoneCalibrationAssets {
    static func loadManifest(bundle: Bundle = .main) throws
        -> VoicePhoneCalibrationManifest
    {
        guard let url = bundle.url(
            forResource: "VoicePhoneCalibrationManifest",
            withExtension: "json"
        ) else {
            throw VoicePronunciationScoringError.missingCalibrationManifest
        }
        let manifest = try JSONDecoder().decode(
            VoicePhoneCalibrationManifest.self,
            from: Data(contentsOf: url)
        )
        try VoicePronunciationScorer.validate(manifest)
        return manifest
    }
}

enum VoicePhoneAssessmentBand: String, Codable, Equatable, Sendable {
    case needsAttention
    case close
    case clear

    var displayName: String {
        switch self {
        case .needsAttention: "Needs attention"
        case .close: "Close"
        case .clear: "Clear"
        }
    }
}

enum VoicePhoneAssessmentSupportStatus: String, Codable, Equatable, Sendable {
    case supported
    case calibrationUnavailable
    case staleEvidence
    case unsupportedLocale
    case unsupportedPhone
    case insufficientEvidence
    case clippedAudio
    case outOfDomainDuration

    var displayName: String {
        switch self {
        case .supported: "Supported"
        case .calibrationUnavailable: "Calibration unavailable"
        case .staleEvidence: "Stale evidence"
        case .unsupportedLocale: "Unsupported locale"
        case .unsupportedPhone: "Unsupported phone"
        case .insufficientEvidence: "Insufficient evidence"
        case .clippedAudio: "Clipped audio"
        case .outOfDomainDuration: "Out-of-domain duration"
        }
    }
}

struct VoicePhoneAssessmentProvenance: Codable, Equatable, Sendable {
    let audioSHA256: String
    let evidenceSHA256: String
    let modelWeightSHA256: String
    let modelSpecificationSHA256: String
    let vocabularySHA256: String
    let featureVersion: String
    let calibrationManifestSHA256: String
}

struct VoiceAlignedPhoneAssessment: Codable, Equatable, Sendable {
    let evidenceIndex: Int
    let targetPhone: String
    let candidateMargins: VoicePronunciationCandidateMargins
    let selectedCandidate: VoicePronunciationScoreCandidate
    let selectedRawMargin: Double
    let expectedExpertGrade: Double?
    let band: VoicePhoneAssessmentBand?
    let supportStatus: VoicePhoneAssessmentSupportStatus
    let abstentionReason: String?
}

struct VoicePhoneAssessment: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let attemptID: UUID
    let createdAt: Date
    let calibrationIdentifier: String
    let calibrationCorpus: String
    let calibrationPopulation: String
    let provenance: VoicePhoneAssessmentProvenance
    let phones: [VoiceAlignedPhoneAssessment]

    var isWellFormed: Bool {
        schemaVersion == Self.currentSchemaVersion
            && !calibrationIdentifier.isEmpty
            && !calibrationCorpus.isEmpty
            && !calibrationPopulation.isEmpty
            && !provenance.audioSHA256.isEmpty
            && !provenance.evidenceSHA256.isEmpty
            && !provenance.modelWeightSHA256.isEmpty
            && !provenance.modelSpecificationSHA256.isEmpty
            && !provenance.vocabularySHA256.isEmpty
            && provenance.featureVersion == VoicePhoneScoreFeatures.currentVersion
            && !provenance.calibrationManifestSHA256.isEmpty
            && phones.enumerated().allSatisfy {
                $0.offset == $0.element.evidenceIndex
                    && $0.element.targetPhone.isEmpty == false
                    && $0.element.selectedRawMargin.isFinite
                    && $0.element.candidateMargins.values.allSatisfy(\.isFinite)
                    && ($0.element.expectedExpertGrade == nil)
                        == ($0.element.supportStatus != .supported)
                    && ($0.element.band == nil)
                        == ($0.element.supportStatus != .supported)
                    && ($0.element.abstentionReason == nil)
                        == ($0.element.supportStatus == .supported)
                    && ($0.element.expectedExpertGrade.map {
                        $0.isFinite && (0...2).contains($0)
                    } ?? true)
            }
    }

    func isCurrent(
        for evidence: VoicePhoneEvidence,
        calibration: VoicePhoneCalibrationManifest
    ) -> Bool {
        guard let evidenceSHA256 = VoicePronunciationHashing.sha256(evidence),
              let calibrationSHA256 = calibration.contentSHA256
        else {
            return false
        }
        return schemaVersion == Self.currentSchemaVersion
            && isWellFormed
            && attemptID == evidence.attemptID
            && provenance.audioSHA256 == evidence.audioSHA256
            && provenance.evidenceSHA256 == evidenceSHA256
            && provenance.modelWeightSHA256 == evidence.model.modelWeightSHA256
            && provenance.modelSpecificationSHA256
                == evidence.model.modelSpecificationSHA256
            && provenance.vocabularySHA256 == evidence.model.vocabularySHA256
            && provenance.featureVersion == VoicePhoneScoreFeatures.currentVersion
            && provenance.calibrationManifestSHA256 == calibrationSHA256
            && calibrationIdentifier == calibration.identifier
            && phones.count == evidence.alignedPhones.count
            && zip(phones, evidence.alignedPhones).allSatisfy {
                $0.evidenceIndex >= 0
                    && $0.targetPhone == $1.targetPhone
            }
    }
}

enum VoicePronunciationScoringError: LocalizedError, Equatable {
    case missingCalibrationManifest
    case invalidCalibrationManifest(String)
    case invalidEvidence(String)

    var errorDescription: String? {
        switch self {
        case .missingCalibrationManifest:
            "The pinned pronunciation calibration manifest is missing."
        case .invalidCalibrationManifest(let reason):
            "The pronunciation calibration manifest is invalid: \(reason)"
        case .invalidEvidence(let reason):
            "The retained phone evidence cannot be scored: \(reason)"
        }
    }
}

enum VoicePronunciationScorer {
    static func score(
        evidence: VoicePhoneEvidence,
        calibration: VoicePhoneCalibrationManifest,
        now: Date = Date()
    ) throws -> VoicePhoneAssessment {
        guard evidence.schemaVersion == VoicePhoneEvidence.currentSchemaVersion else {
            throw VoicePronunciationScoringError.invalidEvidence(
                "schema \(evidence.schemaVersion) is unsupported"
            )
        }
        guard evidence.alignedPhones.count == evidence.pronunciation.phones.count,
              zip(evidence.alignedPhones, evidence.pronunciation.phones)
                .allSatisfy({ $0.targetPhone == $1 })
        else {
            throw VoicePronunciationScoringError.invalidEvidence(
                "aligned phones do not match the target pronunciation"
            )
        }
        try validate(calibration)
        guard let evidenceSHA256 = VoicePronunciationHashing.sha256(evidence),
              let calibrationSHA256 = calibration.contentSHA256
        else {
            throw VoicePronunciationScoringError.invalidEvidence(
                "deterministic provenance encoding failed"
            )
        }

        let provenance = VoicePhoneAssessmentProvenance(
            audioSHA256: evidence.audioSHA256,
            evidenceSHA256: evidenceSHA256,
            modelWeightSHA256: evidence.model.modelWeightSHA256,
            modelSpecificationSHA256:
                evidence.model.modelSpecificationSHA256,
            vocabularySHA256: evidence.model.vocabularySHA256,
            featureVersion: VoicePhoneScoreFeatures.currentVersion,
            calibrationManifestSHA256: calibrationSHA256
        )
        let globalAbstention = globalAbstention(
            evidence: evidence,
            calibration: calibration
        )
        let supportByPhone = Dictionary(
            uniqueKeysWithValues: calibration.supportedPhones.map {
                ($0.phone, $0)
            }
        )
        let mappingsByPhone = Dictionary(
            uniqueKeysWithValues: calibration.mappings.compactMap { mapping in
                mapping.phone.map { ($0, mapping) }
            }
        )
        let globalMapping = calibration.mappings.first { $0.phone == nil }

        let phones = try evidence.alignedPhones.enumerated().map { index, phone in
            let margins = VoicePronunciationCandidateMargins(evidence: phone)
            let selectedMargin = margins.value(for: calibration.selectedCandidate)
            if let globalAbstention {
                return abstainedPhone(
                    index: index,
                    phone: phone,
                    margins: margins,
                    calibration: calibration,
                    status: globalAbstention.0,
                    reason: globalAbstention.1
                )
            }
            guard supportByPhone[phone.targetPhone] != nil else {
                return abstainedPhone(
                    index: index,
                    phone: phone,
                    margins: margins,
                    calibration: calibration,
                    status: .unsupportedPhone,
                    reason:
                        "/\(phone.targetPhone)/ did not pass the pinned corpus support gates."
                )
            }
            guard phone.scoreFeatures.featureVersion
                    == VoicePhoneScoreFeatures.currentVersion,
                  phone.scoreFeatures.effectiveNonBlankFrameCount
                    >= calibration.minimumEffectiveNonBlankFrameCount,
                  phone.scoreFeatures.blankFrameRatio
                    <= calibration.maximumBlankFrameRatio
            else {
                return abstainedPhone(
                    index: index,
                    phone: phone,
                    margins: margins,
                    calibration: calibration,
                    status: .insufficientEvidence,
                    reason: "The aligned phone has too little non-blank acoustic support."
                )
            }
            guard selectedMargin.isFinite else {
                return abstainedPhone(
                    index: index,
                    phone: phone,
                    margins: margins,
                    calibration: calibration,
                    status: .insufficientEvidence,
                    reason: "The selected score feature is not finite."
                )
            }
            guard let mapping = mappingsByPhone[phone.targetPhone] ?? globalMapping else {
                throw VoicePronunciationScoringError.invalidCalibrationManifest(
                    "no mapping covers /\(phone.targetPhone)/"
                )
            }
            let grade = interpolate(
                margin: selectedMargin,
                knots: mapping.knots
            )
            return VoiceAlignedPhoneAssessment(
                evidenceIndex: index,
                targetPhone: phone.targetPhone,
                candidateMargins: margins,
                selectedCandidate: calibration.selectedCandidate,
                selectedRawMargin: selectedMargin,
                expectedExpertGrade: grade,
                band: band(for: grade, calibration: calibration),
                supportStatus: .supported,
                abstentionReason: nil
            )
        }
        return VoicePhoneAssessment(
            schemaVersion: VoicePhoneAssessment.currentSchemaVersion,
            attemptID: evidence.attemptID,
            createdAt: now,
            calibrationIdentifier: calibration.identifier,
            calibrationCorpus: calibration.sourceCorpus,
            calibrationPopulation: calibration.sourcePopulation,
            provenance: provenance,
            phones: phones
        )
    }

    static func validate(_ manifest: VoicePhoneCalibrationManifest) throws {
        guard manifest.schemaVersion == VoicePhoneCalibrationManifest.currentSchemaVersion else {
            throw VoicePronunciationScoringError.invalidCalibrationManifest(
                "schema \(manifest.schemaVersion) is unsupported"
            )
        }
        guard manifest.featureVersion == VoicePhoneScoreFeatures.currentVersion else {
            throw VoicePronunciationScoringError.invalidCalibrationManifest(
                "feature version \(manifest.featureVersion) is unsupported"
            )
        }
        guard !manifest.identifier.isEmpty,
              !manifest.sourceCorpus.isEmpty,
              !manifest.sourceRevision.isEmpty,
              !manifest.sourceSHA256.isEmpty,
              !manifest.sourceLicense.isEmpty,
              !manifest.sourcePopulation.isEmpty,
              !manifest.localeIdentifiers.isEmpty,
              manifest.localeIdentifiers.allSatisfy({ !$0.isEmpty }),
              Set(manifest.localeIdentifiers).count
                == manifest.localeIdentifiers.count,
              !manifest.modelWeightSHA256.isEmpty,
              !manifest.modelSpecificationSHA256.isEmpty,
              !manifest.vocabularySHA256.isEmpty
        else {
            throw VoicePronunciationScoringError.invalidCalibrationManifest(
                "provenance fields are missing or duplicated"
            )
        }
        guard (0...1).contains(manifest.maximumBlankFrameRatio),
              (0...1).contains(manifest.maximumClippedSampleRatio),
              manifest.maximumSourceDurationSeconds > 0,
              manifest.minimumEffectiveNonBlankFrameCount > 0,
              0 <= manifest.needsAttentionUpperBound,
              manifest.needsAttentionUpperBound < manifest.closeUpperBound,
              manifest.closeUpperBound <= 2
        else {
            throw VoicePronunciationScoringError.invalidCalibrationManifest(
                "bounds are inconsistent"
            )
        }
        let duplicatePhones = Dictionary(grouping: manifest.supportedPhones, by: \.phone)
            .contains { $0.value.count > 1 }
        guard !duplicatePhones else {
            throw VoicePronunciationScoringError.invalidCalibrationManifest(
                "supported phones are duplicated"
            )
        }
        let mappingPhones = manifest.mappings.compactMap(\.phone)
        guard Set(mappingPhones).count == mappingPhones.count,
              manifest.mappings.filter({ $0.phone == nil }).count <= 1
        else {
            throw VoicePronunciationScoringError.invalidCalibrationManifest(
                "calibration mappings are duplicated"
            )
        }
        for mapping in manifest.mappings {
            guard mapping.knots.count >= 2,
                  zip(mapping.knots, mapping.knots.dropFirst()).allSatisfy({
                      $0.margin < $1.margin
                          && $0.expectedGrade <= $1.expectedGrade
                  }),
                  mapping.knots.allSatisfy({
                      $0.margin.isFinite
                          && $0.expectedGrade.isFinite
                          && (0...2).contains($0.expectedGrade)
                  })
            else {
                throw VoicePronunciationScoringError.invalidCalibrationManifest(
                    "mapping knots must be finite and monotonic"
                )
            }
        }
        if manifest.displayEnabled {
            guard let validation = manifest.validation,
                  manifest.disabledReason == nil,
                  manifest.mappings.contains(where: { $0.phone == nil })
                    || !manifest.supportedPhones.isEmpty
            else {
                throw VoicePronunciationScoringError.invalidCalibrationManifest(
                    "enabled calibration lacks validation or mappings"
                )
            }
            let validationValues = [
                validation.testPearsonCorrelation,
                validation.testSpearmanCorrelation,
                validation.testMeanAbsoluteError,
                validation.testAUROC,
                validation.testCalibrationError,
                validation.speakerBootstrapPearsonLowerBound
            ]
            guard validationValues.allSatisfy(\.isFinite),
                  validation.testPearsonCorrelation >= 0.50,
                  validation.testSpearmanCorrelation >= 0.50,
                  validation.testMeanAbsoluteError <= 0.35,
                  validation.testAUROC >= 0.80,
                  validation.testCalibrationError <= 0.10,
                  validation.speakerBootstrapPearsonLowerBound >= 0.45,
                  validation.l2ArcticOverallAUROC.map({
                      $0.isFinite && $0 >= 0.70
                  }) == true,
                  validation.l2ArcticWorstL1AUROC.map({
                      $0.isFinite && $0 >= 0.55
                  }) == true,
                  validation.l2ArcticWorstRecallGap.map({
                      $0.isFinite && $0 <= 0.20
                  }) == true
            else {
                throw VoicePronunciationScoringError.invalidCalibrationManifest(
                    "enabled calibration does not pass its validation gates"
                )
            }
            let supportedPhoneSet = Set(manifest.supportedPhones.map(\.phone))
            let mappingsCoverSupportedPhones = manifest.mappings.contains(
                where: { $0.phone == nil }
            )
                || supportedPhoneSet.allSatisfy { mappingPhones.contains($0) }
            guard supportedPhoneSet == VoiceARPABETPhoneMapping.productPhones,
                  manifest.supportedPhones.allSatisfy({
                      $0.trainingCount >= 100
                          && $0.testCount >= 20
                          && $0.lowGradeTrainingCount > 0
                          && $0.highGradeTrainingCount > 0
                          && $0.lowGradeTestCount >= 10
                          && $0.highGradeTestCount >= 10
                          && $0.testPearsonCorrelation.isFinite
                          && $0.testPearsonCorrelation >= 0
                          && $0.testMeanAbsoluteError.isFinite
                          && $0.testMeanAbsoluteError <= 0.5
                  }),
                  mappingsCoverSupportedPhones
            else {
                throw VoicePronunciationScoringError.invalidCalibrationManifest(
                    "enabled calibration does not cover the product phone gates"
                )
            }
        } else {
            guard manifest.disabledReason?.isEmpty == false,
                  manifest.validation == nil,
                  manifest.mappings.isEmpty,
                  manifest.supportedPhones.isEmpty
            else {
                throw VoicePronunciationScoringError.invalidCalibrationManifest(
                    "disabled calibration must contain only a visible reason"
                )
            }
        }
    }

    private static func globalAbstention(
        evidence: VoicePhoneEvidence,
        calibration: VoicePhoneCalibrationManifest
    ) -> (VoicePhoneAssessmentSupportStatus, String)? {
        guard calibration.displayEnabled else {
            return (
                .calibrationUnavailable,
                calibration.disabledReason
                    ?? "The pinned calibration has not passed its release gates."
            )
        }
        guard calibration.modelWeightSHA256 == evidence.model.modelWeightSHA256,
              calibration.modelSpecificationSHA256
                == evidence.model.modelSpecificationSHA256,
              calibration.vocabularySHA256 == evidence.model.vocabularySHA256
        else {
            return (
                .staleEvidence,
                "The evidence model or vocabulary differs from the pinned calibration."
            )
        }
        guard calibration.localeIdentifiers.contains(evidence.localeIdentifier) else {
            return (
                .unsupportedLocale,
                "\(evidence.localeIdentifier) is outside the calibration domain."
            )
        }
        guard evidence.metrics.sourceDurationSeconds
                <= calibration.maximumSourceDurationSeconds
        else {
            return (
                .outOfDomainDuration,
                "The recording exceeds the calibration duration contract."
            )
        }
        guard evidence.metrics.clippedSampleRatio
                <= calibration.maximumClippedSampleRatio
        else {
            return (
                .clippedAudio,
                "The recording contains too many clipped samples."
            )
        }
        return nil
    }

    private static func abstainedPhone(
        index: Int,
        phone: VoiceAlignedPhoneEvidence,
        margins: VoicePronunciationCandidateMargins,
        calibration: VoicePhoneCalibrationManifest,
        status: VoicePhoneAssessmentSupportStatus,
        reason: String
    ) -> VoiceAlignedPhoneAssessment {
        VoiceAlignedPhoneAssessment(
            evidenceIndex: index,
            targetPhone: phone.targetPhone,
            candidateMargins: margins,
            selectedCandidate: calibration.selectedCandidate,
            selectedRawMargin: margins.value(for: calibration.selectedCandidate),
            expectedExpertGrade: nil,
            band: nil,
            supportStatus: status,
            abstentionReason: reason
        )
    }

    static func interpolate(
        margin: Double,
        knots: [VoicePhoneCalibrationKnot]
    ) -> Double {
        guard margin > knots[0].margin else {
            return knots[0].expectedGrade
        }
        guard margin < knots[knots.count - 1].margin else {
            return knots[knots.count - 1].expectedGrade
        }
        let upperIndex = knots.firstIndex { $0.margin >= margin }!
        let lower = knots[upperIndex - 1]
        let upper = knots[upperIndex]
        let fraction = (margin - lower.margin) / (upper.margin - lower.margin)
        return lower.expectedGrade
            + fraction * (upper.expectedGrade - lower.expectedGrade)
    }

    private static func band(
        for grade: Double,
        calibration: VoicePhoneCalibrationManifest
    ) -> VoicePhoneAssessmentBand {
        if grade < calibration.needsAttentionUpperBound {
            return .needsAttention
        }
        if grade < calibration.closeUpperBound {
            return .close
        }
        return .clear
    }
}

enum VoicePronunciationHashing {
    static func sha256<T: Encodable>(_ value: T) -> String? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return nil }
        return SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
