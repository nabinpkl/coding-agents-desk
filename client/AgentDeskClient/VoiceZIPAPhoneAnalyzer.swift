import Accelerate
import AVFoundation
import CryptoKit
import Foundation
import OnnxRuntimeBindings

actor VoicePassagePhoneAnalyzer {
    private let assets: VoiceAssetCache
    private let wav2vec2: VoicePhoneAnalyzer
    private let zipa: VoiceZIPAPhoneAnalyzer

    init(assets: VoiceAssetCache = .shared) {
        self.assets = assets
        wav2vec2 = VoicePhoneAnalyzer(assets: assets)
        zipa = VoiceZIPAPhoneAnalyzer(assets: assets)
    }

    func analyze(
        model: VoicePassagePhoneModel,
        analysisID: UUID,
        audioURL: URL,
        localeIdentifier: String
    ) async throws -> VoicePassagePhoneObservation {
        switch model {
        case .zipa:
            return try await zipa.analyze(
                analysisID: analysisID,
                audioURL: audioURL
            )
        case .wav2vec2:
            let manifest = try VoicePhoneModelAssets.loadManifest(
                assets: assets
            )
            return try await wav2vec2.analyzePassage(
                VoicePhoneAnalyzer.PassageRequest(
                    analysisID: analysisID,
                    audioURL: audioURL,
                    localeIdentifier: localeIdentifier,
                    modelManifest: manifest
                )
            )
        }
    }
}

actor VoiceZIPAPhoneAnalyzer {
    private struct LoadedRuntime {
        let assets: VoiceZIPAModelAssets
        let environment: ORTEnv
        let session: ORTSession
    }

    private static let chunkSeconds = 12
    private static let overlapSeconds = 0.4

    private let assets: VoiceAssetCache

    init(assets: VoiceAssetCache = .shared) {
        self.assets = assets
    }

    func analyze(
        analysisID: UUID,
        audioURL: URL
    ) throws -> VoicePassagePhoneObservation {
        ClientDiagnostics.shared.record(
            type: "voicePassageZIPAStarted",
            fields: ["analysisID": analysisID.uuidString],
            level: .info
        )
        do {
            try Task.checkCancellation()
            let runtime = try loadRuntime()
            ClientDiagnostics.shared.record(
                type: "voicePassageZIPAModelLoaded",
                fields: [
                    "analysisID": analysisID.uuidString,
                    "modelSHA256":
                        runtime.assets.manifest.modelSHA256
                ],
                level: .info
            )
            let prepared = try Self.prepareAudio(
                at: audioURL,
                sampleRate: runtime.assets.manifest.sampleRate
            )
            let audioData = try Data(
                contentsOf: audioURL,
                options: .mappedIfSafe
            )
            let sampleRate = runtime.assets.manifest.sampleRate
            let chunkSamples = Self.chunkSeconds * sampleRate
            let overlapSamples = Int(
                Self.overlapSeconds * Double(sampleRate)
            )
            let stepSamples = chunkSamples - overlapSamples
            var phones: [String] = []
            var chunkCount = 0
            var offset = 0
            repeat {
                try Task.checkCancellation()
                let end = min(
                    prepared.samples.count,
                    offset + chunkSamples
                )
                ClientDiagnostics.shared.record(
                    type: "voicePassageZIPAChunkStarted",
                    fields: [
                        "analysisID": analysisID.uuidString,
                        "chunkIndex": String(chunkCount),
                        "sampleOffset": String(offset),
                        "sampleCount": String(end - offset)
                    ],
                    level: .info
                )
                let chunk = Array(prepared.samples[offset..<end])
                let decoded = try infer(
                    samples: chunk,
                    runtime: runtime
                )
                try Task.checkCancellation()
                Self.appendChunk(decoded, to: &phones)
                chunkCount += 1
                if end == prepared.samples.count {
                    break
                }
                offset += stepSamples
            } while offset < prepared.samples.count

            ClientDiagnostics.shared.record(
                type: "voicePassageZIPACompleted",
                fields: [
                    "analysisID": analysisID.uuidString,
                    "chunkCount": String(chunkCount),
                    "phoneCount": String(phones.count)
                ],
                level: .info
            )
            return VoicePassagePhoneObservation(
                phones: phones,
                sourceDurationSeconds: prepared.durationSeconds,
                analyzedChunkCount: chunkCount,
                audioSHA256: SHA256.hash(data: audioData).hexString,
                modelWeightSHA256:
                    runtime.assets.manifest.modelSHA256
            )
        } catch is CancellationError {
            ClientDiagnostics.shared.record(
                type: "voicePassageZIPACancelled",
                fields: ["analysisID": analysisID.uuidString],
                level: .info
            )
            throw CancellationError()
        } catch {
            ClientDiagnostics.shared.record(
                type: "voicePassageZIPAFailed",
                fields: [
                    "analysisID": analysisID.uuidString,
                    "errorType": String(reflecting: type(of: error)),
                    "message": String(
                        error.localizedDescription.prefix(1_000)
                    )
                ],
                level: .error
            )
            throw error
        }
    }

    private func loadRuntime() throws -> LoadedRuntime {
        let assets = try VoiceZIPAModelAssets.load(assets: assets)
        let environment = try ORTEnv(loggingLevel: .warning)
        let options = try ORTSessionOptions()
        try options.setGraphOptimizationLevel(.all)
        try options.setIntraOpNumThreads(2)
        let session = try ORTSession(
            env: environment,
            modelPath: assets.modelURL.path,
            sessionOptions: options
        )
        return LoadedRuntime(
            assets: assets,
            environment: environment,
            session: session
        )
    }

    private func infer(
        samples: [Float],
        runtime: LoadedRuntime
    ) throws -> [String] {
        let features = try VoiceZIPAFilterbank.extract(samples: samples)
        guard features.frameCount > 0 else {
            throw VoiceZIPAModelError.invalidAudio(
                "the recording is too short for one filterbank frame"
            )
        }
        let featureData = NSMutableData(
            bytes: features.values,
            length: features.values.count * MemoryLayout<Float>.stride
        )
        var frameCount = Int64(features.frameCount)
        let lengthData = NSMutableData(
            bytes: &frameCount,
            length: MemoryLayout<Int64>.stride
        )
        let featureValue = try ORTValue(
            tensorData: featureData,
            elementType: .float,
            shape: [1, NSNumber(value: features.frameCount), 80]
        )
        let lengthValue = try ORTValue(
            tensorData: lengthData,
            elementType: .int64,
            shape: [1]
        )
        let outputs = try runtime.session.run(
            withInputs: [
                "x": featureValue,
                "x_lens": lengthValue
            ],
            outputNames: ["log_probs", "log_probs_len"],
            runOptions: nil
        )
        guard let probabilities = outputs["log_probs"],
              let outputLength = outputs["log_probs_len"]
        else {
            throw VoiceZIPAModelError.invalidOutput(
                "required CTC outputs are missing"
            )
        }
        let shape = try probabilities.tensorTypeAndShapeInfo().shape.map(\.intValue)
        guard shape.count == 3,
              shape[0] == 1,
              shape[2] == runtime.assets.manifest.vocabularySize
        else {
            throw VoiceZIPAModelError.invalidOutput(
                "log_probs shape is \(shape)"
            )
        }
        let lengthTensor = try outputLength.tensorData()
        guard lengthTensor.length >= MemoryLayout<Int64>.stride else {
            throw VoiceZIPAModelError.invalidOutput(
                "log_probs_len is empty"
            )
        }
        var validFrameCount: Int64 = 0
        lengthTensor.getBytes(
            &validFrameCount,
            length: MemoryLayout<Int64>.stride
        )
        let validFrames = Int(validFrameCount)
        guard validFrames > 0, validFrames <= shape[1] else {
            throw VoiceZIPAModelError.invalidOutput(
                "valid frame count \(validFrames) exceeds \(shape[1])"
            )
        }
        let probabilityData = try probabilities.tensorData()
        let valueCount = shape.reduce(1, *)
        guard probabilityData.length == valueCount * MemoryLayout<Float>.stride else {
            throw VoiceZIPAModelError.invalidOutput(
                "log_probs contains \(probabilityData.length) bytes"
            )
        }
        let values = probabilityData.bytes.bindMemory(
            to: Float.self,
            capacity: valueCount
        )
        let tokenIDs = Self.greedyCTCDecode(
            values: UnsafeBufferPointer(start: values, count: valueCount),
            frameCount: validFrames,
            vocabularySize: shape[2],
            blankTokenID: runtime.assets.manifest.blankTokenID
        )
        let tokens = tokenIDs.compactMap { identifier -> String? in
            let token = runtime.assets.tokensByID[identifier]
            return token == "▁" || token.hasPrefix("<") ? nil : token
        }
        return VoiceZIPAPhoneUnits.merge(tokens)
    }

    static func greedyCTCDecode(
        values: UnsafeBufferPointer<Float>,
        frameCount: Int,
        vocabularySize: Int,
        blankTokenID: Int
    ) -> [Int] {
        var decoded: [Int] = []
        var previous = -1
        for frame in 0..<frameCount {
            let start = frame * vocabularySize
            var winner = 0
            var winnerValue = values[start]
            for identifier in 1..<vocabularySize {
                let value = values[start + identifier]
                if value > winnerValue {
                    winner = identifier
                    winnerValue = value
                }
            }
            if winner != blankTokenID, winner != previous {
                decoded.append(winner)
            }
            previous = winner
        }
        return decoded
    }

    static func appendChunk(
        _ chunk: [String],
        to phones: inout [String]
    ) {
        let maximumOverlap = min(8, phones.count, chunk.count)
        let overlap = stride(
            from: maximumOverlap,
            through: 1,
            by: -1
        ).first {
            Array(phones.suffix($0)) == Array(chunk.prefix($0))
        } ?? 0
        phones.append(contentsOf: chunk.dropFirst(overlap))
    }

    private static func prepareAudio(
        at url: URL,
        sampleRate: Int
    ) throws -> (samples: [Float], durationSeconds: TimeInterval) {
        let file = try AVAudioFile(forReading: url)
        guard file.length > 0 else {
            throw VoiceZIPAModelError.invalidAudio(
                "the saved recording contains no samples"
            )
        }
        let sourceDuration =
            Double(file.length) / file.processingFormat.sampleRate
        guard sourceDuration <= VoicePassagePhoneObservation.maximumDurationSeconds else {
            throw VoicePhoneAnalyzerError.passageRecordingTooLong(
                sourceDuration
            )
        }
        let sourceBuffer = try VoiceAudioFileReader.readAll(from: file)
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(sampleRate),
            channels: 1,
            interleaved: false
        ) else {
            throw VoiceZIPAModelError.invalidAudio(
                "the 16 kHz mono format is unavailable"
            )
        }
        let converted = try VoiceBufferConverter().convert(
            sourceBuffer,
            to: targetFormat
        )
        guard let channel = converted.floatChannelData?[0],
              converted.frameLength > 0
        else {
            throw VoiceZIPAModelError.invalidAudio(
                "audio conversion returned no samples"
            )
        }
        let samples = Array(
            UnsafeBufferPointer(
                start: channel,
                count: Int(converted.frameLength)
            )
        )
        return (
            samples,
            Double(samples.count) / Double(sampleRate)
        )
    }
}

enum VoiceZIPAPhoneUnits {
    private static let pairedPhones: Set<String> = [
        "aɪ", "aʊ", "dʒ", "eɪ", "oʊ", "tʃ", "ɔɪ"
    ]
    private static let modifiers: Set<String> = [
        "ː", "˞", "ˠ", "ˤ", "̃", "̚", "̥", "̩", "̪", "̴", "̺", "ʰ", "ʲ", "ʷ"
    ]

    static func merge(_ tokens: [String]) -> [String] {
        var phones: [String] = []
        for token in tokens {
            if modifiers.contains(token), !phones.isEmpty {
                phones[phones.count - 1] += token
                continue
            }
            if let previous = phones.last,
               pairedPhones.contains(previous + token)
            {
                phones[phones.count - 1] += token
                continue
            }
            phones.append(token == "g" ? "ɡ" : token)
        }
        return phones
    }
}

enum VoiceZIPAFilterbank {
    struct Features: Equatable, Sendable {
        let frameCount: Int
        let values: [Float]
    }

    private static let sampleRate = 16_000
    private static let frameLength = 400
    private static let frameShift = 160
    private static let fftLength = 512
    private static let filterCount = 80
    private static let preemphasis: Float = 0.97
    private static let epsilon = Float.ulpOfOne

    static func extract(samples: [Float]) throws -> Features {
        guard samples.count >= frameLength else {
            throw VoiceZIPAModelError.invalidAudio(
                "at least 25 ms of audio is required"
            )
        }
        let frameCount = (samples.count + frameShift / 2) / frameShift
        let window = poveyWindow
        let filters = melFilters
        let transform = try vDSP.DiscreteFourierTransform<DSPComplex>(
            count: fftLength,
            direction: .forward,
            transformType: .complexComplex,
            ofType: DSPComplex.self
        )
        var features = [Float]()
        features.reserveCapacity(frameCount * filterCount)
        let leftPadding = frameLength / 2 - frameShift / 2

        for frameIndex in 0..<frameCount {
            let start = frameIndex * frameShift - leftPadding
            var centered = [Float](repeating: 0, count: frameLength)
            var mean: Float = 0
            for sampleIndex in 0..<frameLength {
                let value = reflectedSample(
                    samples,
                    index: start + sampleIndex
                )
                centered[sampleIndex] = value
                mean += value
            }
            mean /= Float(frameLength)
            for sampleIndex in 0..<frameLength {
                centered[sampleIndex] -= mean
            }

            var input = [DSPComplex](
                repeating: DSPComplex(real: 0, imag: 0),
                count: fftLength
            )
            for sampleIndex in 0..<frameLength {
                let previous = centered[max(0, sampleIndex - 1)]
                input[sampleIndex].real =
                    (centered[sampleIndex] - preemphasis * previous)
                    * window[sampleIndex]
            }
            let spectrum = transform.transform(input: input)
            var powers = [Float](repeating: 0, count: fftLength / 2)
            for bin in powers.indices {
                let value = spectrum[bin]
                powers[bin] = value.real * value.real
                    + value.imag * value.imag
            }
            for filter in 0..<filterCount {
                let weights = filters[filter]
                var energy: Float = 0
                vDSP_dotpr(
                    powers,
                    1,
                    weights,
                    1,
                    &energy,
                    vDSP_Length(powers.count)
                )
                features.append(log(max(energy, epsilon)))
            }
        }
        return Features(frameCount: frameCount, values: features)
    }

    private static func reflectedSample(
        _ samples: [Float],
        index: Int
    ) -> Float {
        if index < 0 {
            return samples[-index - 1]
        }
        if index >= samples.count {
            return samples[2 * samples.count - index - 1]
        }
        return samples[index]
    }

    private static let poveyWindow: [Float] = {
        (0..<frameLength).map { index in
            let phase = 2 * Double.pi * Double(index)
                / Double(frameLength - 1)
            return Float(pow(0.5 - 0.5 * cos(phase), 0.85))
        }
    }()

    private static let melFilters: [[Float]] = {
        let lowMel = melScale(20)
        let highMel = melScale(Double(sampleRate) / 2)
        let delta = (highMel - lowMel) / Double(filterCount + 1)
        let binWidth = Double(sampleRate) / Double(fftLength)
        return (0..<filterCount).map { filter in
            let left = lowMel + Double(filter) * delta
            let center = lowMel + Double(filter + 1) * delta
            let right = lowMel + Double(filter + 2) * delta
            return (0..<(fftLength / 2)).map { bin in
                let mel = melScale(Double(bin) * binWidth)
                let rising = (mel - left) / (center - left)
                let falling = (right - mel) / (right - center)
                return Float(max(0, min(rising, falling)))
            }
        }
    }()

    private static func melScale(_ frequency: Double) -> Double {
        1_127 * log(1 + frequency / 700)
    }
}
