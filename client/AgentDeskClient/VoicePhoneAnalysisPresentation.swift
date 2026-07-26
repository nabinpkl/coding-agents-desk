import Foundation

enum VoicePhoneAnalysisMessageTone {
    case neutral
    case warning
    case error
}

struct VoicePhoneAnalysisMessage {
    let title: String
    let detail: String
    let tone: VoicePhoneAnalysisMessageTone
}

struct VoicePhoneAnalysisDetail {
    let label: String
    let value: String
}

struct VoicePhoneAnalysisPhone {
    let expectedPhone: String
    let observedPhone: String
    let timeRange: String
    let assessmentTitle: String
    let assessmentDetail: String
    let assessmentTone: VoicePhoneAnalysisMessageTone
    let evidence: [VoicePhoneAnalysisDetail]
    let competitors: String
    let calibration: String?

    var accessibilitySummary: String {
        let evidenceSummary = evidence.map { "\($0.label), \($0.value)" }
            .joined(separator: ". ")
        return [
            "Expected \(expectedPhone).",
            "Model heard \(observedPhone).",
            "Range \(timeRange).",
            "\(assessmentTitle).",
            assessmentDetail,
            evidenceSummary,
            "Competing phones, \(competitors).",
            calibration.map { "Calibration, \($0)." }
        ]
        .compactMap { $0 }
        .joined(separator: " ")
    }
}

struct VoicePhoneAnalysisEvidence {
    let targetWord: String
    let targetSequence: String
    let phones: [VoicePhoneAnalysisPhone]
    let technicalDetails: [VoicePhoneAnalysisDetail]

    var accessibilitySummary: String {
        let phonesSummary = phones.map(\.accessibilitySummary)
            .joined(separator: " ")
        let technicalSummary = technicalDetails
            .map { "\($0.label), \($0.value)" }
            .joined(separator: ". ")
        return """
        Raw acoustic evidence for \(targetWord). Expected sequence \(targetSequence). \
        \(phonesSummary) Technical details. \(technicalSummary)
        """
    }
}

enum VoicePhoneAnalysisPresentation {
    case message(VoicePhoneAnalysisMessage)
    case evidence(VoicePhoneAnalysisEvidence)

    static func make(
        analysis: VoiceStoredPhoneAnalysis?,
        assessment: VoicePhoneAssessment?,
        calibration: VoicePhoneCalibrationManifest?,
        audioSHA256: String?,
        readFailure: String?,
        assessmentReadFailure: String?
    ) -> VoicePhoneAnalysisPresentation {
        if let readFailure {
            return .message(
                VoicePhoneAnalysisMessage(
                    title: "Phone evidence could not be read",
                    detail: readFailure,
                    tone: .error
                )
            )
        }
        guard let analysis else {
            return .message(
                VoicePhoneAnalysisMessage(
                    title: "Raw audio not analyzed",
                    detail: """
                    This pass reads audio.caf directly. It does not receive either \
                    speech transcript.
                    """,
                    tone: .neutral
                )
            )
        }
        guard analysis.audioSHA256 == audioSHA256 else {
            return .message(
                VoicePhoneAnalysisMessage(
                    title: "Stored evidence is stale",
                    detail: "The saved audio changed. Reanalyze to replace it.",
                    tone: .warning
                )
            )
        }
        if let failure = analysis.failure {
            return .message(
                VoicePhoneAnalysisMessage(
                    title: "Phone analysis failed",
                    detail: failure,
                    tone: .error
                )
            )
        }
        guard analysis.modelWeightSHA256
                == VoicePhoneModelManifest.selectedWeightSHA256,
              analysis.evidence?.model.modelSpecificationSHA256
                == VoicePhoneModelManifest.selectedSpecificationSHA256
        else {
            return .message(
                VoicePhoneAnalysisMessage(
                    title: "Stored evidence is stale",
                    detail: "The selected model hashes changed. Reanalyze to replace it.",
                    tone: .warning
                )
            )
        }
        guard let evidence = analysis.evidence else {
            return .message(
                VoicePhoneAnalysisMessage(
                    title: "Phone evidence is incomplete",
                    detail: "Reanalyze the saved audio to replace the incomplete result.",
                    tone: .error
                )
            )
        }

        let assessmentIsCurrent = assessment.flatMap { assessment in
            calibration.map {
                assessment.isCurrent(for: evidence, calibration: $0)
            }
        } ?? false
        let phones = evidence.alignedPhones.enumerated().map { index, phone in
            let assessmentPresentation = assessmentPresentation(
                index: index,
                assessment: assessment,
                assessmentIsCurrent: assessmentIsCurrent,
                assessmentReadFailure: assessmentReadFailure
            )
            let competitors = phone.competingPhones.prefix(3).map {
                "\($0.phone) \(format($0.logPosterior))"
            }
            .joined(separator: "  ·  ")
            return VoicePhoneAnalysisPhone(
                expectedPhone: phone.targetPhone,
                observedPhone: phone.observedPhone.phone,
                timeRange: String(
                    format: "%.2f–%.2fs",
                    phone.startSeconds,
                    phone.endSeconds
                ),
                assessmentTitle: assessmentPresentation.title,
                assessmentDetail: assessmentPresentation.detail,
                assessmentTone: assessmentPresentation.tone,
                evidence: [
                    VoicePhoneAnalysisDetail(
                        label: "Target posterior",
                        value: format(phone.targetLogPosterior)
                    ),
                    VoicePhoneAnalysisDetail(
                        label: "Observed posterior",
                        value: format(phone.observedPhone.logPosterior)
                    ),
                    VoicePhoneAnalysisDetail(
                        label: "Aligned margin",
                        value: signed(phone.posteriorMargin)
                    ),
                    VoicePhoneAnalysisDetail(
                        label: assessmentPresentation.scoreLabel,
                        value: assessmentPresentation.scoreValue
                    )
                ],
                competitors: competitors,
                calibration: assessmentPresentation.calibration
            )
        }

        let memory: String
        if let bytes = evidence.metrics.observedResidentMemoryDeltaBytes {
            memory = String(
                format: "%.1f MiB observed RSS delta",
                Double(bytes) / 1_048_576
            )
        } else {
            memory = "RSS delta unavailable"
        }
        let analyzedEnd = evidence.metrics.analyzedOffsetSeconds
            + evidence.metrics.analyzedDurationSeconds
        let window = String(
            format: "%.2f–%.2fs of %.2fs source",
            evidence.metrics.analyzedOffsetSeconds,
            analyzedEnd,
            evidence.metrics.sourceDurationSeconds
        )
        return .evidence(
            VoicePhoneAnalysisEvidence(
                targetWord: evidence.pronunciation.word,
                targetSequence: evidence.pronunciation.phones.joined(separator: "  "),
                phones: phones,
                technicalDetails: [
                    VoicePhoneAnalysisDetail(
                        label: "Model",
                        value: evidence.model.identifier
                    ),
                    VoicePhoneAnalysisDetail(
                        label: "Model hash",
                        value: String(evidence.model.modelWeightSHA256.prefix(12))
                    ),
                    VoicePhoneAnalysisDetail(
                        label: "Audio hash",
                        value: String(evidence.audioSHA256.prefix(12))
                    ),
                    VoicePhoneAnalysisDetail(label: "Analyzed window", value: window),
                    VoicePhoneAnalysisDetail(
                        label: "Model load",
                        value: String(
                            format: "%.0f ms",
                            evidence.metrics.modelLoadMilliseconds
                        )
                    ),
                    VoicePhoneAnalysisDetail(
                        label: "Inference",
                        value: String(
                            format: "%.0f ms",
                            evidence.metrics.inferenceMilliseconds
                        )
                    ),
                    VoicePhoneAnalysisDetail(label: "Memory", value: memory)
                ]
            )
        )
    }

    var accessibilitySummary: String {
        switch self {
        case .message(let message):
            "\(message.title). \(message.detail)"
        case .evidence(let evidence):
            evidence.accessibilitySummary
        }
    }

    private static func assessmentPresentation(
        index: Int,
        assessment: VoicePhoneAssessment?,
        assessmentIsCurrent: Bool,
        assessmentReadFailure: String?
    ) -> (
        title: String,
        detail: String,
        tone: VoicePhoneAnalysisMessageTone,
        scoreLabel: String,
        scoreValue: String,
        calibration: String?
    ) {
        if assessmentIsCurrent,
           let assessment,
           assessment.phones.indices.contains(index) {
            let phone = assessment.phones[index]
            let calibration = "\(assessment.calibrationCorpus) · "
                + assessment.calibrationPopulation
            if let grade = phone.expectedExpertGrade,
               let band = phone.band {
                return (
                    "\(band.displayName) · \(String(format: "%.1f", grade))/2.0",
                    "Calibrated expected expert phone grade.",
                    .neutral,
                    phone.selectedCandidate.displayName,
                    signed(phone.selectedRawMargin),
                    calibration
                )
            }
            return (
                "No calibrated grade",
                "\(phone.supportStatus.displayName). "
                    + (phone.abstentionReason
                        ?? "No abstention reason was retained."),
                .warning,
                phone.selectedCandidate.displayName,
                signed(phone.selectedRawMargin),
                calibration
            )
        }
        if let assessmentReadFailure {
            return (
                "No calibrated grade",
                assessmentReadFailure,
                .error,
                "Selected raw score",
                "Unavailable",
                nil
            )
        }
        if assessment != nil {
            return (
                "Calibration needs refresh",
                "Re-score retained evidence with the current calibration.",
                .warning,
                "Selected raw score",
                "Stale",
                nil
            )
        }
        return (
            "Calibration not saved",
            "Re-score retained evidence without rerunning Core ML.",
            .neutral,
            "Selected raw score",
            "Not saved",
            nil
        )
    }

    private static func format(_ value: Double) -> String {
        String(format: "%.2f", value)
    }

    private static func signed(_ value: Double) -> String {
        String(format: "%+.2f", value)
    }
}

private extension VoicePronunciationScoreCandidate {
    var displayName: String {
        switch self {
        case .alignedPosteriorMargin:
            "Aligned posterior score"
        case .alignedLogitMargin:
            "Aligned logit score"
        case .alignmentFreeSubstitutionMargin:
            "CTC substitution score"
        case .alignmentFreeSubstitutionDeletionMargin:
            "CTC substitution + deletion score"
        }
    }
}
