import AVFoundation
import CoreML
import CryptoKit
import Darwin
import Foundation

enum VoicePhoneAnalyzerError: LocalizedError {
    case missingAsset(String)
    case invalidManifest(String)
    case invalidVocabulary(String)
    case invalidModelOutput(String)
    case analysisLogWriteFailed(String)
    case emptyRecording
    case recordingTooLong(TimeInterval)
    case passageRecordingTooLong(TimeInterval)
    case audioBufferAllocationFailed

    var errorDescription: String? {
        switch self {
        case .missingAsset(let name):
            return "Voice model file \(name) has not been downloaded from your Mac yet."
        case .invalidManifest(let detail):
            return "The phone model manifest is invalid: \(detail)"
        case .invalidVocabulary(let detail):
            return "The phone model vocabulary is invalid: \(detail)"
        case .invalidModelOutput(let detail):
            return "The phone model returned an unexpected tensor: \(detail)"
        case .analysisLogWriteFailed(let detail):
            return "Phone analysis could not persist its diagnostic log: \(detail)"
        case .emptyRecording:
            return "The saved recording contains no audio."
        case .recordingTooLong(let duration):
            return String(
                format: "Phone analysis accepts recordings up to 30 seconds; this take is %.1f seconds.",
                duration
            )
        case .passageRecordingTooLong(let duration):
            return String(
                format: "Passage analysis accepts recordings up to %.0f seconds; this take is %.1f seconds.",
                VoicePassagePhoneObservation.maximumDurationSeconds,
                duration
            )
        case .audioBufferAllocationFailed:
            return "Phone analysis could not allocate an audio conversion buffer."
        }
    }
}

struct VoicePhoneTokenKey: Hashable, Sendable {
    private let unicodeScalars: [UInt32]

    init(_ token: String) {
        unicodeScalars = token.unicodeScalars.map(\.value)
    }
}

struct VoicePhoneVocabulary {
    let tokensByID: [Int: String]
    private let tokenIDs: [VoicePhoneTokenKey: Int]

    init(tokens: [String]) throws {
        var tokensByID: [Int: String] = [:]
        var tokenIDs: [VoicePhoneTokenKey: Int] = [:]
        for (tokenID, token) in tokens.enumerated() {
            let key = VoicePhoneTokenKey(token)
            guard tokenIDs[key] == nil else {
                throw VoicePhoneAnalyzerError.invalidVocabulary(
                    "token \(token) has a duplicated Unicode scalar sequence"
                )
            }
            tokensByID[tokenID] = token
            tokenIDs[key] = tokenID
        }
        self.tokensByID = tokensByID
        self.tokenIDs = tokenIDs
    }

    func tokenID(for token: String) -> Int? {
        tokenIDs[VoicePhoneTokenKey(token)]
    }
}

enum VoicePhoneModelAssets {
    static func loadManifest(assets: VoiceAssetCache = .shared) throws -> VoicePhoneModelManifest {
        let url = try resourceURL(
            named: "VoicePhoneModelManifest",
            extension: "json",
            assets: assets
        )
        let manifest = try JSONDecoder().decode(
            VoicePhoneModelManifest.self,
            from: Data(contentsOf: url)
        )
        guard manifest.schemaVersion == VoicePhoneModelManifest.currentSchemaVersion else {
            throw VoicePhoneAnalyzerError.invalidManifest(
                "schema \(manifest.schemaVersion) is unsupported"
            )
        }
        guard manifest.modelWeightSHA256
                == VoicePhoneModelManifest.selectedWeightSHA256
        else {
            throw VoicePhoneAnalyzerError.invalidManifest(
                "model weight hash does not match the selected R130 checkpoint"
            )
        }
        guard manifest.minimumIOSVersion == 26,
              manifest.sampleRate == 16_000,
              manifest.sampleCount == 64_000,
              manifest.frameCount == 199,
              manifest.vocabularySize == 392,
              manifest.blankTokenID == 0
        else {
            throw VoicePhoneAnalyzerError.invalidManifest(
                "the tensor contract does not match the selected model"
            )
        }
        return manifest
    }

    static func loadVocabulary(
        manifest: VoicePhoneModelManifest,
        assets: VoiceAssetCache = .shared
    ) throws -> VoicePhoneVocabulary {
        let url = try resourceURL(
            named: "VoicePhoneVocabulary",
            extension: "json",
            assets: assets
        )
        let data = try Data(contentsOf: url)
        let hash = SHA256.hash(data: data).hexString
        guard hash == manifest.vocabularySHA256 else {
            throw VoicePhoneAnalyzerError.invalidVocabulary(
                "SHA-256 does not match the pinned manifest"
            )
        }
        return try decodeVocabulary(data: data, manifest: manifest)
    }

    static func decodeVocabulary(
        data: Data,
        manifest: VoicePhoneModelManifest
    ) throws -> VoicePhoneVocabulary {
        let tokens: [String]
        do {
            tokens = try JSONDecoder().decode([String].self, from: data)
        } catch {
            throw VoicePhoneAnalyzerError.invalidVocabulary(
                "expected an ID-ordered token array"
            )
        }
        guard tokens.count == manifest.vocabularySize else {
            throw VoicePhoneAnalyzerError.invalidVocabulary(
                "expected \(manifest.vocabularySize) tokens, found \(tokens.count)"
            )
        }
        let vocabulary = try VoicePhoneVocabulary(tokens: tokens)
        guard vocabulary.tokensByID[manifest.blankTokenID] == "<pad>" else {
            throw VoicePhoneAnalyzerError.invalidVocabulary(
                "the CTC blank is not <pad>"
            )
        }
        return vocabulary
    }

    static func loadModelURL(assets: VoiceAssetCache = .shared) throws -> URL {
        try resourceURL(
            named: "VoicePhoneModel",
            extension: "mlmodelc",
            assets: assets
        )
    }

    private static func resourceURL(
        named name: String,
        extension fileExtension: String,
        assets: VoiceAssetCache
    ) throws -> URL {
        guard let url = assets.assetURL(
            named: name,
            extension: fileExtension
        ) else {
            throw VoicePhoneAnalyzerError.missingAsset("\(name).\(fileExtension)")
        }
        return url
    }
}

actor VoicePhoneAnalyzer {
    struct Request: Equatable, Sendable {
        let attemptID: UUID
        let audioURL: URL
        let pronunciation: VoiceTargetPronunciation
        let localeIdentifier: String
        let modelManifest: VoicePhoneModelManifest
    }

    struct PassageRequest: Equatable, Sendable {
        let analysisID: UUID
        let audioURL: URL
        let localeIdentifier: String
        let modelManifest: VoicePhoneModelManifest
    }

    private struct LoadedAssets {
        let manifest: VoicePhoneModelManifest
        let vocabulary: VoicePhoneVocabulary
        let model: MLModel
    }

    private struct PreparedAudio {
        let samples: [Float]
        let sourceDurationSeconds: TimeInterval
        let analyzedOffsetSeconds: TimeInterval
        let analyzedDurationSeconds: TimeInterval
        let peakAbsoluteSample: Double
        let clippedSampleRatio: Double
    }

    struct SupportDiagnostics: Equatable, Sendable {
        let blankFrameRatio: Double
        let effectiveNonBlankFrameCount: Int
    }

    private let assets: VoiceAssetCache
    private var loadedAssets: LoadedAssets?

    init(assets: VoiceAssetCache = .shared) {
        self.assets = assets
    }

    func analyze(_ request: Request) throws -> VoicePhoneEvidence {
        let residentBefore = Self.residentMemoryBytes()
        defer {
            // The model is large and Voice mode can coexist with a live video
            // transport. Do not retain its compiled resources after one spike.
            loadedAssets = nil
            ClientDiagnostics.shared.record(
                type: "voicePhoneModelReleased",
                fields: [
                    "residentMemoryBytes": Self.residentMemoryBytes().map(String.init) ?? "unavailable"
                ],
                level: .info
            )
        }
        var analysisLog = try VoicePhoneAnalysisLogWriter(
            attemptID: request.attemptID,
            audioURL: request.audioURL,
            modelWeightSHA256: request.modelManifest.modelWeightSHA256,
            residentMemoryBytes: residentBefore
        )
        do {
            return try analyze(
                request,
                residentBefore: residentBefore,
                analysisLog: &analysisLog
            )
        } catch {
            let analysisError = error
            do {
                try analysisLog.record(
                    .analysisFailed,
                    residentMemoryBytes: Self.residentMemoryBytes(),
                    details: [
                        "errorType": String(reflecting: type(of: analysisError)),
                        "message": String(analysisError.localizedDescription.prefix(1_000))
                    ]
                )
            } catch {
                throw VoicePhoneAnalyzerError.analysisLogWriteFailed(
                    "analysis error: \(analysisError.localizedDescription); "
                        + "log error: \(error.localizedDescription)"
                )
            }
            throw analysisError
        }
    }

    func analyzePassage(
        _ request: PassageRequest
    ) throws -> VoicePassagePhoneObservation {
        let residentBefore = Self.residentMemoryBytes()
        defer {
            loadedAssets = nil
            ClientDiagnostics.shared.record(
                type: "voicePassagePhoneModelReleased",
                fields: [
                    "residentMemoryBytes":
                        Self.residentMemoryBytes().map(String.init)
                            ?? "unavailable"
                ],
                level: .info
            )
        }
        var analysisLog = try VoicePhoneAnalysisLogWriter(
            attemptID: request.analysisID,
            audioURL: request.audioURL,
            modelWeightSHA256: request.modelManifest.modelWeightSHA256,
            residentMemoryBytes: residentBefore
        )
        do {
            return try analyzePassage(
                request,
                analysisLog: &analysisLog
            )
        } catch {
            let analysisError = error
            do {
                try analysisLog.record(
                    .analysisFailed,
                    residentMemoryBytes: Self.residentMemoryBytes(),
                    details: [
                        "analysisMode": "passage",
                        "errorType": String(
                            reflecting: type(of: analysisError)
                        ),
                        "message": String(
                            analysisError.localizedDescription.prefix(1_000)
                        )
                    ]
                )
            } catch {
                throw VoicePhoneAnalyzerError.analysisLogWriteFailed(
                    "passage analysis error: \(analysisError.localizedDescription); "
                        + "log error: \(error.localizedDescription)"
                )
            }
            throw analysisError
        }
    }

    private func analyzePassage(
        _ request: PassageRequest,
        analysisLog: inout VoicePhoneAnalysisLogWriter
    ) throws -> VoicePassagePhoneObservation {
        try analysisLog.record(
            .audioReadStarted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["analysisMode": "passage"]
        )
        let audioData = try Data(
            contentsOf: request.audioURL,
            options: .mappedIfSafe
        )
        let audioSHA256 = SHA256.hash(data: audioData).hexString
        try analysisLog.record(
            .audioReadCompleted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: [
                "analysisMode": "passage",
                "sourceBytes": String(audioData.count)
            ]
        )

        try analysisLog.record(
            .audioPreparationStarted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["analysisMode": "passage"]
        )
        let passageAudio = try preparePassageAudio(
            url: request.audioURL,
            manifest: request.modelManifest
        )
        let chunkStarts = stride(
            from: 0,
            to: passageAudio.samples.count,
            by: request.modelManifest.sampleCount
        )
        .map { $0 }
        try analysisLog.record(
            .audioPrepared,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: [
                "analysisMode": "passage",
                "analyzedSamples": String(passageAudio.samples.count),
                "chunkCount": String(chunkStarts.count),
                "sourceDurationMilliseconds": String(
                    Int((passageAudio.durationSeconds * 1_000).rounded())
                )
            ]
        )

        try analysisLog.record(
            .assetsLoadStarted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["analysisMode": "passage"]
        )
        let (assets, _) = try assets(
            for: request.modelManifest,
            analysisLog: &analysisLog
        )
        let excludedTokenIDs = Set([
            request.modelManifest.blankTokenID,
            1,
            2,
            3
        ])
        var observedPhones: [String] = []
        for (chunkIndex, start) in chunkStarts.enumerated() {
            try Task.checkCancellation()
            let end = min(
                start + request.modelManifest.sampleCount,
                passageAudio.samples.count
            )
            var chunk = Array(passageAudio.samples[start..<end])
            if chunk.count < request.modelManifest.sampleCount {
                chunk.append(
                    contentsOf: repeatElement(
                        0,
                        count: request.modelManifest.sampleCount - chunk.count
                    )
                )
            }

            try analysisLog.record(
                .inputAllocationStarted,
                residentMemoryBytes: Self.residentMemoryBytes(),
                details: [
                    "analysisMode": "passage",
                    "chunkIndex": String(chunkIndex),
                    "sampleCount": String(chunk.count)
                ]
            )
            let input = try MLMultiArray(
                shape: [
                    1,
                    NSNumber(value: request.modelManifest.sampleCount)
                ],
                dataType: .float32
            )
            for index in chunk.indices {
                input[index] = NSNumber(value: chunk[index])
            }
            let provider = try MLDictionaryFeatureProvider(dictionary: [
                "input_values": MLFeatureValue(multiArray: input)
            ])
            try analysisLog.record(
                .inputPrepared,
                residentMemoryBytes: Self.residentMemoryBytes(),
                details: [
                    "analysisMode": "passage",
                    "chunkIndex": String(chunkIndex)
                ]
            )

            try analysisLog.record(
                .inferenceStarted,
                residentMemoryBytes: Self.residentMemoryBytes(),
                details: [
                    "analysisMode": "passage",
                    "chunkIndex": String(chunkIndex)
                ]
            )
            let inferenceStart = CFAbsoluteTimeGetCurrent()
            let prediction = try autoreleasepool {
                try assets.model.prediction(from: provider)
            }
            let inferenceMilliseconds =
                (CFAbsoluteTimeGetCurrent() - inferenceStart) * 1_000
            try analysisLog.record(
                .inferenceCompleted,
                residentMemoryBytes: Self.residentMemoryBytes(),
                details: [
                    "analysisMode": "passage",
                    "chunkIndex": String(chunkIndex),
                    "elapsedMilliseconds": String(
                        Int(inferenceMilliseconds.rounded())
                    )
                ]
            )
            guard let output = prediction.featureValue(
                for: "logits"
            )?.multiArrayValue else {
                throw VoicePhoneAnalyzerError.invalidModelOutput(
                    "missing passage logits for chunk \(chunkIndex)"
                )
            }
            try analysisLog.record(
                .logitsCopyStarted,
                residentMemoryBytes: Self.residentMemoryBytes(),
                details: [
                    "analysisMode": "passage",
                    "chunkIndex": String(chunkIndex),
                    "shape": output.shape.map(\.stringValue)
                        .joined(separator: "x")
                ]
            )
            let logits = try Self.copyLogits(
                output,
                frameCount: request.modelManifest.frameCount,
                vocabularySize: request.modelManifest.vocabularySize
            )
            let logPosteriors = try VoiceCTCAlignment.logPosteriors(
                logits: logits
            )
            let tokenIDs = VoiceCTCAlignment.greedyTokens(
                logPosteriors: logPosteriors,
                blankTokenID: request.modelManifest.blankTokenID
            )
            let chunkPhones = tokenIDs.compactMap { tokenID -> String? in
                guard !excludedTokenIDs.contains(tokenID),
                      let phone = assets.vocabulary.tokensByID[tokenID],
                      !phone.hasPrefix("<")
                else {
                    return nil
                }
                return phone
            }
            let appendedPhoneCount = chunkPhones.count
            Self.appendPassageChunk(
                chunkPhones,
                to: &observedPhones
            )
            try analysisLog.record(
                .logitsCopied,
                residentMemoryBytes: Self.residentMemoryBytes(),
                details: [
                    "analysisMode": "passage",
                    "chunkIndex": String(chunkIndex),
                    "decodedPhoneCount": String(appendedPhoneCount)
                ]
            )
        }

        guard !observedPhones.isEmpty else {
            throw VoicePhoneAnalyzerError.invalidModelOutput(
                "no unconstrained phones were decoded from the passage"
            )
        }
        let observation = VoicePassagePhoneObservation(
            phones: observedPhones,
            sourceDurationSeconds: passageAudio.durationSeconds,
            analyzedChunkCount: chunkStarts.count,
            audioSHA256: audioSHA256,
            modelWeightSHA256: request.modelManifest.modelWeightSHA256
        )
        try analysisLog.record(
            .analysisCompleted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: [
                "analysisMode": "passage",
                "chunkCount": String(observation.analyzedChunkCount),
                "decodedPhoneCount": String(observation.phones.count)
            ]
        )
        return observation
    }

    static func appendPassageChunk(
        _ chunk: [String],
        to phones: inout [String]
    ) {
        if phones.last == chunk.first {
            phones.append(contentsOf: chunk.dropFirst())
        } else {
            phones.append(contentsOf: chunk)
        }
    }

    private func analyze(
        _ request: Request,
        residentBefore: UInt64?,
        analysisLog: inout VoicePhoneAnalysisLogWriter
    ) throws -> VoicePhoneEvidence {
        let preprocessingStart = CFAbsoluteTimeGetCurrent()
        try analysisLog.record(
            .audioReadStarted,
            residentMemoryBytes: Self.residentMemoryBytes()
        )
        let audioData = try Data(contentsOf: request.audioURL, options: .mappedIfSafe)
        try analysisLog.record(
            .audioReadCompleted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["sourceBytes": String(audioData.count)]
        )
        let audioSHA256 = SHA256.hash(data: audioData).hexString
        try analysisLog.record(
            .audioPreparationStarted,
            residentMemoryBytes: Self.residentMemoryBytes()
        )
        let audio = try prepareAudio(url: request.audioURL, manifest: request.modelManifest)
        try analysisLog.record(
            .audioPrepared,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: [
                "analyzedSamples": String(audio.samples.count),
                "sourceDurationMilliseconds":
                    String(Int((audio.sourceDurationSeconds * 1_000).rounded()))
            ]
        )
        let preprocessingMilliseconds =
            (CFAbsoluteTimeGetCurrent() - preprocessingStart) * 1_000

        let loadStart = CFAbsoluteTimeGetCurrent()
        try analysisLog.record(
            .assetsLoadStarted,
            residentMemoryBytes: Self.residentMemoryBytes()
        )
        let (assets, didLoad) = try assets(
            for: request.modelManifest,
            analysisLog: &analysisLog
        )
        let modelLoadMilliseconds = didLoad
            ? (CFAbsoluteTimeGetCurrent() - loadStart) * 1_000
            : 0

        let targetTokenIDs = try request.pronunciation.phones.map { phone in
            guard let tokenID = assets.vocabulary.tokenID(for: phone) else {
                throw VoicePhoneAnalyzerError.invalidVocabulary(
                    "target phone \(phone) is absent"
                )
            }
            return tokenID
        }
        let assessmentTokenIDs = try VoiceARPABETPhoneMapping.assessmentPhones.map {
            phone in
            guard let tokenID = assets.vocabulary.tokenID(for: phone) else {
                throw VoicePhoneAnalyzerError.invalidVocabulary(
                    "assessment phone \(phone) is absent"
                )
            }
            return tokenID
        }

        try analysisLog.record(
            .inputAllocationStarted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["sampleCount": String(request.modelManifest.sampleCount)]
        )
        let input = try MLMultiArray(
            shape: [1, NSNumber(value: request.modelManifest.sampleCount)],
            dataType: .float32
        )
        for index in audio.samples.indices {
            input[index] = NSNumber(value: audio.samples[index])
        }
        let provider = try MLDictionaryFeatureProvider(dictionary: [
            "input_values": MLFeatureValue(multiArray: input)
        ])
        try analysisLog.record(
            .inputPrepared,
            residentMemoryBytes: Self.residentMemoryBytes()
        )

        let inferenceStart = CFAbsoluteTimeGetCurrent()
        try analysisLog.record(
            .inferenceStarted,
            residentMemoryBytes: Self.residentMemoryBytes()
        )
        let prediction = try autoreleasepool {
            try assets.model.prediction(from: provider)
        }
        let inferenceMilliseconds =
            (CFAbsoluteTimeGetCurrent() - inferenceStart) * 1_000
        try analysisLog.record(
            .inferenceCompleted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: [
                "elapsedMilliseconds":
                    String(Int(inferenceMilliseconds.rounded()))
            ]
        )
        guard let output = prediction.featureValue(for: "logits")?.multiArrayValue else {
            throw VoicePhoneAnalyzerError.invalidModelOutput("missing logits")
        }
        try analysisLog.record(
            .logitsCopyStarted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["shape": output.shape.map(\.stringValue).joined(separator: "x")]
        )
        let logits = try Self.copyLogits(
            output,
            frameCount: request.modelManifest.frameCount,
            vocabularySize: request.modelManifest.vocabularySize
        )
        try analysisLog.record(
            .logitsCopied,
            residentMemoryBytes: Self.residentMemoryBytes()
        )
        let logPosteriors = try VoiceCTCAlignment.logPosteriors(logits: logits)
        try analysisLog.record(
            .alignmentStarted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["targetPhoneCount": String(targetTokenIDs.count)]
        )
        let alignment = try VoiceCTCAlignment.align(
            logPosteriors: logPosteriors,
            targetTokenIDs: targetTokenIDs,
            blankTokenID: request.modelManifest.blankTokenID
        )

        let frameDuration =
            Double(request.modelManifest.sampleCount)
            / Double(request.modelManifest.sampleRate)
            / Double(request.modelManifest.frameCount)
        let excludedTokens = Set([request.modelManifest.blankTokenID, 1, 2, 3])
        let frames = logPosteriors.indices.map { frameIndex in
            VoicePhoneFrameEvidence(
                startSeconds: audio.analyzedOffsetSeconds
                    + Double(frameIndex) * frameDuration,
                endSeconds: audio.analyzedOffsetSeconds
                    + Double(frameIndex + 1) * frameDuration,
                hypotheses: VoiceCTCAlignment.topHypotheses(
                    frame: logPosteriors[frameIndex],
                    vocabulary: assets.vocabulary.tokensByID,
                    limit: 5,
                    excludingTokenIDs: excludedTokens
                )
            )
        }
        let alignedPhones = try request.pronunciation.phones.indices.map { index in
            let targetTokenID = targetTokenIDs[index]
            let range = alignment.tokenFrameRanges[index]
            let averaged = Self.averagePosteriors(
                logPosteriors: logPosteriors,
                range: range
            )
            let averagedLogits = Self.averageLogits(
                logits: logits,
                range: range
            )
            guard let observed = VoiceCTCAlignment.topHypotheses(
                frame: averaged,
                vocabulary: assets.vocabulary.tokensByID,
                limit: 1,
                excludingTokenIDs: excludedTokens
            ).first else {
                throw VoicePhoneAnalyzerError.invalidModelOutput(
                    "no phone hypothesis for aligned target"
                )
            }
            let competitors = VoiceCTCAlignment.topHypotheses(
                frame: averaged,
                vocabulary: assets.vocabulary.tokensByID,
                limit: 3,
                excludingTokenIDs: excludedTokens.union([targetTokenID])
            )
            guard let strongestCompetitor = competitors.first else {
                throw VoicePhoneAnalyzerError.invalidModelOutput(
                    "no competing phone for aligned target"
                )
            }
            let targetLogPosterior = averaged[targetTokenID]
            let strongestLogitCompetitor = averagedLogits.indices
                .filter {
                    $0 != targetTokenID
                        && !excludedTokens.contains($0)
                        && !(assets.vocabulary.tokensByID[$0]?.hasPrefix("<")
                            ?? true)
                }
                .max { averagedLogits[$0] < averagedLogits[$1] }
            guard let strongestLogitCompetitor else {
                throw VoicePhoneAnalyzerError.invalidModelOutput(
                    "no competing logit for aligned target"
                )
            }
            let contrast = try VoiceCTCAlignment.phoneContrastProbabilities(
                logPosteriors: logPosteriors,
                targetTokenIDs: targetTokenIDs,
                targetIndex: index,
                assessmentTokenIDs: assessmentTokenIDs,
                blankTokenID: request.modelManifest.blankTokenID
            )
            let supportDiagnostics = Self.supportDiagnostics(
                logPosteriors: logPosteriors,
                range: range,
                assessmentTokenIDs: assessmentTokenIDs,
                blankTokenID: request.modelManifest.blankTokenID
            )
            let substitutionDeletionLogSum = VoiceCTCAlignment.logSumExp([
                contrast.substitutionLogSumProbability,
                contrast.deletionLogProbability
            ])
            return VoiceAlignedPhoneEvidence(
                targetPhone: request.pronunciation.phones[index],
                startSeconds: audio.analyzedOffsetSeconds
                    + Double(range.lowerBound) * frameDuration,
                endSeconds: audio.analyzedOffsetSeconds
                    + Double(range.upperBound + 1) * frameDuration,
                targetLogPosterior: targetLogPosterior,
                observedPhone: observed,
                competingPhones: competitors,
                posteriorMargin: targetLogPosterior
                    - strongestCompetitor.logPosterior,
                scoreFeatures: VoicePhoneScoreFeatures(
                    featureVersion: VoicePhoneScoreFeatures.currentVersion,
                    alignedTargetMeanLogit: averagedLogits[targetTokenID],
                    alignedStrongestCompetitorMeanLogit:
                        averagedLogits[strongestLogitCompetitor],
                    alignedLogitMargin: averagedLogits[targetTokenID]
                        - averagedLogits[strongestLogitCompetitor],
                    canonicalSequenceLogProbability:
                        contrast.canonicalLogProbability,
                    substitutionSequenceLogSumProbability:
                        contrast.substitutionLogSumProbability,
                    deletionSequenceLogProbability:
                        contrast.deletionLogProbability,
                    alignmentFreeSubstitutionMargin:
                        contrast.canonicalLogProbability
                        - contrast.substitutionLogSumProbability,
                    alignmentFreeSubstitutionDeletionMargin:
                        contrast.canonicalLogProbability
                        - substitutionDeletionLogSum,
                    blankFrameRatio: supportDiagnostics.blankFrameRatio,
                    effectiveNonBlankFrameCount:
                        supportDiagnostics.effectiveNonBlankFrameCount
                )
            )
        }
        try analysisLog.record(
            .alignmentCompleted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: [
                "alignedPhoneCount": String(alignedPhones.count),
                "frameCount": String(frames.count)
            ]
        )

        let residentAfter = Self.residentMemoryBytes()
        let residentDelta = residentBefore.flatMap { before in
            residentAfter.map { after in after > before ? after - before : 0 }
        }
        let evidence = VoicePhoneEvidence(
            schemaVersion: VoicePhoneEvidence.currentSchemaVersion,
            attemptID: request.attemptID,
            createdAt: Date(),
            audioSHA256: audioSHA256,
            localeIdentifier: request.localeIdentifier,
            model: request.modelManifest,
            pronunciation: request.pronunciation,
            frames: frames,
            alignedPhones: alignedPhones,
            metrics: VoicePhoneInferenceMetrics(
                sourceDurationSeconds: audio.sourceDurationSeconds,
                analyzedOffsetSeconds: audio.analyzedOffsetSeconds,
                analyzedDurationSeconds: audio.analyzedDurationSeconds,
                preprocessingMilliseconds: preprocessingMilliseconds,
                modelLoadMilliseconds: modelLoadMilliseconds,
                inferenceMilliseconds: inferenceMilliseconds,
                observedResidentMemoryDeltaBytes: residentDelta,
                peakAbsoluteSample: audio.peakAbsoluteSample,
                clippedSampleRatio: audio.clippedSampleRatio
            )
        )
        try analysisLog.record(
            .analysisCompleted,
            residentMemoryBytes: residentAfter,
            details: [
                "modelLoadMilliseconds":
                    String(Int(modelLoadMilliseconds.rounded())),
                "inferenceMilliseconds":
                    String(Int(inferenceMilliseconds.rounded()))
            ]
        )
        return evidence
    }

    private func assets(
        for manifest: VoicePhoneModelManifest,
        analysisLog: inout VoicePhoneAnalysisLogWriter
    ) throws -> (LoadedAssets, Bool) {
        if let loadedAssets {
            guard loadedAssets.manifest == manifest else {
                throw VoicePhoneAnalyzerError.invalidManifest(
                    "the request differs from the loaded model"
                )
            }
            try analysisLog.record(
                .assetsCacheHit,
                residentMemoryBytes: Self.residentMemoryBytes()
            )
            return (loadedAssets, false)
        }

        let cachedManifest = try VoicePhoneModelAssets.loadManifest(assets: assets)
        try analysisLog.record(
            .manifestLoaded,
            residentMemoryBytes: Self.residentMemoryBytes()
        )
        guard cachedManifest == manifest else {
            throw VoicePhoneAnalyzerError.invalidManifest(
                "the request differs from the model on this phone"
            )
        }
        let vocabulary = try VoicePhoneModelAssets.loadVocabulary(
            manifest: manifest,
            assets: assets
        )
        try analysisLog.record(
            .vocabularyLoaded,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["vocabularyEntryCount": String(vocabulary.tokensByID.count)]
        )
        let modelURL = try VoicePhoneModelAssets.loadModelURL(assets: assets)
        let configuration = MLModelConfiguration()
        // Voice can run while the video stack still owns GPU-backed decode and
        // presentation resources. Keep inference on CPU/Neural Engine so Core ML
        // cannot add a second large GPU working set.
        configuration.computeUnits = .cpuAndNeuralEngine
        try analysisLog.record(
            .modelLoadStarted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["computeUnits": "cpuAndNeuralEngine"]
        )
        let model = try MLModel(contentsOf: modelURL, configuration: configuration)
        try analysisLog.record(
            .modelLoaded,
            residentMemoryBytes: Self.residentMemoryBytes()
        )
        let assets = LoadedAssets(
            manifest: manifest,
            vocabulary: vocabulary,
            model: model
        )
        loadedAssets = assets
        return (assets, true)
    }

    private func prepareAudio(
        url: URL,
        manifest: VoicePhoneModelManifest
    ) throws -> PreparedAudio {
        let file = try AVAudioFile(forReading: url)
        guard file.length > 0 else {
            throw VoicePhoneAnalyzerError.emptyRecording
        }
        let sourceDuration = Double(file.length) / file.processingFormat.sampleRate
        guard sourceDuration <= 30 else {
            throw VoicePhoneAnalyzerError.recordingTooLong(sourceDuration)
        }
        let sourceBuffer = try VoiceAudioFileReader.readAll(from: file)
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(manifest.sampleRate),
            channels: 1,
            interleaved: false
        ) else {
            throw VoicePhoneAnalyzerError.audioBufferAllocationFailed
        }
        let converted = try VoiceBufferConverter().convert(
            sourceBuffer,
            to: targetFormat
        )
        guard let channel = converted.floatChannelData?[0] else {
            throw VoicePhoneAnalyzerError.audioBufferAllocationFailed
        }
        let sampleCount = Int(converted.frameLength)
        guard sampleCount > 0 else {
            throw VoicePhoneAnalyzerError.emptyRecording
        }
        let samples = Array(UnsafeBufferPointer(start: channel, count: sampleCount))
        let peakAbsoluteSample = samples.reduce(0.0) {
            max($0, Double(abs($1)))
        }
        let clippedSampleRatio = Double(
            samples.lazy.filter { abs($0) >= 0.999 }.count
        ) / Double(samples.count)
        let windowSize = manifest.sampleCount
        if samples.count <= windowSize {
            return PreparedAudio(
                samples: samples + Array(repeating: 0, count: windowSize - samples.count),
                sourceDurationSeconds: Double(samples.count) / Double(manifest.sampleRate),
                analyzedOffsetSeconds: 0,
                analyzedDurationSeconds: Double(samples.count) / Double(manifest.sampleRate),
                peakAbsoluteSample: peakAbsoluteSample,
                clippedSampleRatio: clippedSampleRatio
            )
        }

        let offset = Self.highestEnergyWindowOffset(
            samples: samples,
            windowSize: windowSize
        )
        return PreparedAudio(
            samples: Array(samples[offset..<(offset + windowSize)]),
            sourceDurationSeconds: Double(samples.count) / Double(manifest.sampleRate),
            analyzedOffsetSeconds: Double(offset) / Double(manifest.sampleRate),
            analyzedDurationSeconds: Double(windowSize) / Double(manifest.sampleRate),
            peakAbsoluteSample: peakAbsoluteSample,
            clippedSampleRatio: clippedSampleRatio
        )
    }

    private func preparePassageAudio(
        url: URL,
        manifest: VoicePhoneModelManifest
    ) throws -> (samples: [Float], durationSeconds: TimeInterval) {
        let file = try AVAudioFile(forReading: url)
        guard file.length > 0 else {
            throw VoicePhoneAnalyzerError.emptyRecording
        }
        let sourceDuration =
            Double(file.length) / file.processingFormat.sampleRate
        guard sourceDuration
                <= VoicePassagePhoneObservation.maximumDurationSeconds
        else {
            throw VoicePhoneAnalyzerError.passageRecordingTooLong(
                sourceDuration
            )
        }
        let sourceBuffer = try VoiceAudioFileReader.readAll(from: file)
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(manifest.sampleRate),
            channels: 1,
            interleaved: false
        ) else {
            throw VoicePhoneAnalyzerError.audioBufferAllocationFailed
        }
        let converted = try VoiceBufferConverter().convert(
            sourceBuffer,
            to: targetFormat
        )
        guard let channel = converted.floatChannelData?[0] else {
            throw VoicePhoneAnalyzerError.audioBufferAllocationFailed
        }
        let sampleCount = Int(converted.frameLength)
        guard sampleCount > 0 else {
            throw VoicePhoneAnalyzerError.emptyRecording
        }
        return (
            samples: Array(
                UnsafeBufferPointer(start: channel, count: sampleCount)
            ),
            durationSeconds:
                Double(sampleCount) / Double(manifest.sampleRate)
        )
    }

    private static func highestEnergyWindowOffset(
        samples: [Float],
        windowSize: Int
    ) -> Int {
        var energy = samples[..<windowSize].reduce(0.0) {
            $0 + Double($1 * $1)
        }
        var bestEnergy = energy
        var bestOffset = 0
        for end in windowSize..<samples.count {
            energy += Double(samples[end] * samples[end])
            energy -= Double(samples[end - windowSize] * samples[end - windowSize])
            if energy > bestEnergy {
                bestEnergy = energy
                bestOffset = end - windowSize + 1
            }
        }
        return bestOffset
    }

    static func copyLogits(
        _ array: MLMultiArray,
        frameCount: Int,
        vocabularySize: Int
    ) throws -> [[Float]] {
        let shape = array.shape.map(\.intValue)
        guard shape == [1, frameCount, vocabularySize] else {
            throw VoicePhoneAnalyzerError.invalidModelOutput(
                "expected [1, \(frameCount), \(vocabularySize)], got \(shape)"
            )
        }
        return (0..<frameCount).map { frame in
            (0..<vocabularySize).map { token in
                Float(
                    truncating: array[
                        [
                            NSNumber(value: 0),
                            NSNumber(value: frame),
                            NSNumber(value: token)
                        ]
                    ]
                )
            }
        }
    }

    static func averagePosteriors(
        logPosteriors: [[Double]],
        range: ClosedRange<Int>
    ) -> [Double] {
        let count = Double(range.count)
        return logPosteriors[0].indices.map { token in
            range.reduce(0.0) {
                $0 + logPosteriors[$1][token]
            } / count
        }
    }

    static func averageLogits(
        logits: [[Float]],
        range: ClosedRange<Int>
    ) -> [Double] {
        let count = Double(range.count)
        return logits[0].indices.map { token in
            range.reduce(0.0) {
                $0 + Double(logits[$1][token])
            } / count
        }
    }

    static func supportDiagnostics(
        logPosteriors: [[Double]],
        range: ClosedRange<Int>,
        assessmentTokenIDs: [Int],
        blankTokenID: Int
    ) -> SupportDiagnostics {
        let blankFrames = range.filter { frameIndex in
            let frame = logPosteriors[frameIndex]
            guard let winner = frame.indices.max(
                by: { frame[$0] < frame[$1] }
            ) else {
                return true
            }
            return winner == blankTokenID
        }.count
        let effectiveNonBlankFrames = range.filter { frameIndex in
            let frame = logPosteriors[frameIndex]
            let strongestAssessment = assessmentTokenIDs
                .map { frame[$0] }
                .max() ?? -Double.infinity
            return strongestAssessment > frame[blankTokenID]
        }.count
        return SupportDiagnostics(
            blankFrameRatio: Double(blankFrames) / Double(range.count),
            effectiveNonBlankFrameCount: effectiveNonBlankFrames
        )
    }

    private static func residentMemoryBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size
                / MemoryLayout<natural_t>.size
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(
                to: integer_t.self,
                capacity: Int(count)
            ) {
                task_info(
                    mach_task_self_,
                    task_flavor_t(TASK_VM_INFO),
                    $0,
                    &count
                )
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return info.phys_footprint
    }
}

extension SHA256.Digest {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
