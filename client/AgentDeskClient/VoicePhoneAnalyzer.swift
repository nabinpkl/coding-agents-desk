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
    case audioBufferAllocationFailed

    var errorDescription: String? {
        switch self {
        case .missingAsset(let name):
            return "Phone analysis asset \(name) is missing. Run just voice-phone-model and rebuild."
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
    static func loadManifest(bundle: Bundle = .main) throws -> VoicePhoneModelManifest {
        let url = try resourceURL(
            named: "VoicePhoneModelManifest",
            extension: "json",
            bundle: bundle
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
                == VoicePhoneModelManifest.selectedWeightSHA256,
              manifest.modelSpecificationSHA256
                == VoicePhoneModelManifest.selectedSpecificationSHA256
        else {
            throw VoicePhoneAnalyzerError.invalidManifest(
                "model hashes do not match the selected R130 checkpoint"
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
        bundle: Bundle = .main
    ) throws -> VoicePhoneVocabulary {
        let url = try resourceURL(
            named: "VoicePhoneVocabulary",
            extension: "json",
            bundle: bundle
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

    static func loadModelURL(bundle: Bundle = .main) throws -> URL {
        try resourceURL(
            named: "VoicePhoneModel",
            extension: "mlmodelc",
            bundle: bundle
        )
    }

    private static func resourceURL(
        named name: String,
        extension fileExtension: String,
        bundle: Bundle
    ) throws -> URL {
        if let nested = bundle.url(
            forResource: name,
            withExtension: fileExtension,
            subdirectory: "VoicePhoneModelAssets"
        ) {
            return nested
        }
        if let flattened = bundle.url(
            forResource: name,
            withExtension: fileExtension
        ) {
            return flattened
        }
        throw VoicePhoneAnalyzerError.missingAsset("\(name).\(fileExtension)")
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
    }

    private let bundle: Bundle
    private var loadedAssets: LoadedAssets?

    init(bundle: Bundle = .main) {
        self.bundle = bundle
    }

    func analyze(_ request: Request) throws -> VoicePhoneEvidence {
        let residentBefore = Self.residentMemoryBytes()
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
        let prediction = try assets.model.prediction(from: provider)
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
                    - strongestCompetitor.logPosterior
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
                observedResidentMemoryDeltaBytes: residentDelta
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

        let bundledManifest = try VoicePhoneModelAssets.loadManifest(bundle: bundle)
        try analysisLog.record(
            .bundledManifestLoaded,
            residentMemoryBytes: Self.residentMemoryBytes()
        )
        guard bundledManifest == manifest else {
            throw VoicePhoneAnalyzerError.invalidManifest(
                "the request differs from the bundled model"
            )
        }
        let vocabulary = try VoicePhoneModelAssets.loadVocabulary(
            manifest: manifest,
            bundle: bundle
        )
        try analysisLog.record(
            .vocabularyLoaded,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["vocabularyEntryCount": String(vocabulary.tokensByID.count)]
        )
        let modelURL = try VoicePhoneModelAssets.loadModelURL(bundle: bundle)
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        try analysisLog.record(
            .modelLoadStarted,
            residentMemoryBytes: Self.residentMemoryBytes(),
            details: ["computeUnits": "all"]
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
        guard file.length <= Int64(UInt32.max),
              let sourceBuffer = AVAudioPCMBuffer(
                pcmFormat: file.processingFormat,
                frameCapacity: AVAudioFrameCount(file.length)
              )
        else {
            throw VoicePhoneAnalyzerError.audioBufferAllocationFailed
        }
        try file.read(into: sourceBuffer)
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
        let windowSize = manifest.sampleCount
        if samples.count <= windowSize {
            return PreparedAudio(
                samples: samples + Array(repeating: 0, count: windowSize - samples.count),
                sourceDurationSeconds: Double(samples.count) / Double(manifest.sampleRate),
                analyzedOffsetSeconds: 0,
                analyzedDurationSeconds: Double(samples.count) / Double(manifest.sampleRate)
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
            analyzedDurationSeconds: Double(windowSize) / Double(manifest.sampleRate)
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

    private static func copyLogits(
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
        let frameStride = array.strides[1].intValue
        let tokenStride = array.strides[2].intValue
        return (0..<frameCount).map { frame in
            (0..<vocabularySize).map { token in
                Float(truncating: array[frame * frameStride + token * tokenStride])
            }
        }
    }

    private static func averagePosteriors(
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

private extension SHA256.Digest {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
