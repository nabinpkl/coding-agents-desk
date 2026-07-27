import AVFoundation
import Foundation

public struct ReferenceSpeechRateState: Codable, Equatable, Sendable {
    public let minimum: Double
    public let defaultValue: Double
    public let maximum: Double
    public let current: Double

    public init(minimum: Double, defaultValue: Double, maximum: Double, current: Double) {
        self.minimum = minimum
        self.defaultValue = defaultValue
        self.maximum = maximum
        self.current = current
    }
}

public struct ReferenceSpeechState: Codable, Equatable, Sendable {
    public let language: String
    public let voices: [NativeSpeechVoiceDescriptor]
    public let selectedVoiceIdentifier: String?
    public let rate: ReferenceSpeechRateState
    public let notice: String?
    public let error: String?

    public init(
        language: String,
        voices: [NativeSpeechVoiceDescriptor],
        selectedVoiceIdentifier: String?,
        rate: ReferenceSpeechRateState,
        notice: String? = nil,
        error: String? = nil
    ) {
        self.language = language
        self.voices = voices
        self.selectedVoiceIdentifier = selectedVoiceIdentifier
        self.rate = rate
        self.notice = notice
        self.error = error
    }
}

public enum ReferenceSpeechPreferencesError: LocalizedError, Equatable {
    case invalidRate
    case voiceUnavailable

    public var errorDescription: String? {
        switch self {
        case .invalidRate:
            "The native speech rate must be a finite number."
        case .voiceUnavailable:
            "That voice is no longer available on this device."
        }
    }
}

public final class ReferenceSpeechPreferences {
    public static let language = "en-US"

    private enum Key {
        static let voiceIdentifier = "agentDesk.referenceSpeech.voiceIdentifier"
        static let rate = "agentDesk.referenceSpeech.rate"
    }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func currentState(
        availableVoices: [NativeSpeechVoiceDescriptor] = NativeSpeechVoiceCatalog.currentDescriptors(
            language: ReferenceSpeechPreferences.language
        ),
        error: String? = nil
    ) -> ReferenceSpeechState {
        let voices = NativeSpeechVoiceCatalog.sortedDescriptors(
            availableVoices,
            language: Self.language
        )
        var selectedIdentifier = defaults.string(forKey: Key.voiceIdentifier)
        var notice: String?
        if let storedIdentifier = selectedIdentifier,
           !voices.contains(where: { $0.identifier == storedIdentifier }) {
            defaults.removeObject(forKey: Key.voiceIdentifier)
            notice = "The previously selected voice is no longer available. Using System Default."
            selectedIdentifier = nil
        }

        return ReferenceSpeechState(
            language: Self.language,
            voices: voices,
            selectedVoiceIdentifier: selectedIdentifier,
            rate: rateState,
            notice: notice,
            error: error
        )
    }

    @discardableResult
    public func update(
        voiceIdentifier: String?,
        rate: Double,
        availableVoices: [NativeSpeechVoiceDescriptor] = NativeSpeechVoiceCatalog.currentDescriptors(
            language: ReferenceSpeechPreferences.language
        )
    ) throws -> ReferenceSpeechState {
        guard rate.isFinite else {
            throw ReferenceSpeechPreferencesError.invalidRate
        }
        let voices = NativeSpeechVoiceCatalog.sortedDescriptors(
            availableVoices,
            language: Self.language
        )
        if let voiceIdentifier,
           !voices.contains(where: { $0.identifier == voiceIdentifier }) {
            throw ReferenceSpeechPreferencesError.voiceUnavailable
        }

        if let voiceIdentifier {
            defaults.set(voiceIdentifier, forKey: Key.voiceIdentifier)
        } else {
            defaults.removeObject(forKey: Key.voiceIdentifier)
        }
        defaults.set(clampedRate(rate), forKey: Key.rate)
        return currentState(availableVoices: voices)
    }

    public func configure(_ utterance: AVSpeechUtterance) {
        let voices = NativeSpeechVoiceCatalog.currentVoices(language: Self.language)
        let selectedIdentifier = defaults.string(forKey: Key.voiceIdentifier)
        if let selectedIdentifier,
           let selectedVoice = voices.first(where: { $0.identifier == selectedIdentifier }) {
            utterance.voice = selectedVoice
        } else {
            if selectedIdentifier != nil {
                defaults.removeObject(forKey: Key.voiceIdentifier)
            }
            utterance.voice = AVSpeechSynthesisVoice(language: Self.language)
        }
        utterance.rate = Float(rateState.current)
    }

    private var rateState: ReferenceSpeechRateState {
        let minimum = Double(AVSpeechUtteranceMinimumSpeechRate)
        let defaultValue = Double(AVSpeechUtteranceDefaultSpeechRate)
        let maximum = Double(AVSpeechUtteranceMaximumSpeechRate)
        let storedValue: Double?
        if defaults.object(forKey: Key.rate) != nil {
            let value = defaults.double(forKey: Key.rate)
            storedValue = value.isFinite ? value : nil
        } else {
            storedValue = nil
        }
        let current = clampedRate(storedValue ?? defaultValue)
        if storedValue == nil {
            defaults.removeObject(forKey: Key.rate)
        } else if current != storedValue {
            defaults.set(current, forKey: Key.rate)
        }
        return ReferenceSpeechRateState(
            minimum: minimum,
            defaultValue: defaultValue,
            maximum: maximum,
            current: current
        )
    }

    private func clampedRate(_ rate: Double) -> Double {
        min(
            Double(AVSpeechUtteranceMaximumSpeechRate),
            max(Double(AVSpeechUtteranceMinimumSpeechRate), rate)
        )
    }
}
