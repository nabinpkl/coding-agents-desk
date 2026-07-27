import AVFoundation
import Foundation

public struct NativeSpeechVoiceDescriptor: Codable, Equatable, Sendable {
    public enum Quality: String, Codable, Equatable, Sendable {
        case basic
        case enhanced
        case premium
    }

    public let identifier: String
    public let name: String
    public let language: String
    public let quality: Quality

    public init(identifier: String, name: String, language: String, quality: Quality) {
        self.identifier = identifier
        self.name = name
        self.language = language
        self.quality = quality
    }

    public init(voice: AVSpeechSynthesisVoice) {
        identifier = voice.identifier
        name = voice.name
        language = voice.language
        quality = Self.quality(from: voice.quality)
    }

    public var displayName: String {
        let label = quality.displayName
        return label.isEmpty ? name : "\(name) (\(label))"
    }

    private static func quality(
        from quality: AVSpeechSynthesisVoiceQuality
    ) -> Quality {
        switch quality {
        case .premium:
            .premium
        case .enhanced:
            .enhanced
        default:
            .basic
        }
    }
}

public struct NativeSpeechVoiceSelection: Equatable, Sendable {
    public let voiceIdentifier: String?
    public let language: String?

    public init(voiceIdentifier: String?, language: String?) {
        self.voiceIdentifier = voiceIdentifier
        self.language = language
    }
}

public extension NativeSpeechVoiceDescriptor.Quality {
    var displayName: String {
        switch self {
        case .premium:
            "Premium"
        case .enhanced:
            "Enhanced"
        case .basic:
            ""
        }
    }

    var sortRank: Int {
        switch self {
        case .premium:
            0
        case .enhanced:
            1
        case .basic:
            2
        }
    }
}

public enum NativeSpeechVoiceCatalog {
    public static func currentVoices(language: String? = nil) -> [AVSpeechSynthesisVoice] {
        sortedVoices(AVSpeechSynthesisVoice.speechVoices(), language: language)
    }

    public static func currentDescriptors(language: String? = nil) -> [NativeSpeechVoiceDescriptor] {
        descriptors(from: AVSpeechSynthesisVoice.speechVoices(), language: language)
    }

    public static func sortedVoices(
        _ voices: [AVSpeechSynthesisVoice],
        language: String? = nil
    ) -> [AVSpeechSynthesisVoice] {
        voices
            .filter { language == nil || $0.language == language }
            .sorted { areInIncreasingOrder(
                NativeSpeechVoiceDescriptor(voice: $0),
                NativeSpeechVoiceDescriptor(voice: $1)
            ) }
    }

    public static func descriptors(
        from voices: [AVSpeechSynthesisVoice],
        language: String? = nil
    ) -> [NativeSpeechVoiceDescriptor] {
        sortedDescriptors(
            voices.map(NativeSpeechVoiceDescriptor.init(voice:)),
            language: language
        )
    }

    public static func sortedDescriptors(
        _ voices: [NativeSpeechVoiceDescriptor],
        language: String? = nil
    ) -> [NativeSpeechVoiceDescriptor] {
        voices
            .filter { language == nil || $0.language == language }
            .sorted(by: areInIncreasingOrder)
    }

    public static func resolvedSelection(
        voices: [NativeSpeechVoiceDescriptor],
        voiceIdentifier: String?,
        language: String?,
        preferredLanguages: [String],
        languageOrder: [String]? = nil
    ) -> NativeSpeechVoiceSelection {
        let voices = sortedDescriptors(voices)
        if let voiceIdentifier,
           let selectedVoice = voices.first(where: { $0.identifier == voiceIdentifier }) {
            return NativeSpeechVoiceSelection(
                voiceIdentifier: selectedVoice.identifier,
                language: selectedVoice.language
            )
        }

        let discoveredLanguages = voices.reduce(into: [String]()) { result, voice in
            if !result.contains(voice.language) {
                result.append(voice.language)
            }
        }
        var languages = languageOrder?
            .filter { discoveredLanguages.contains($0) }
            ?? discoveredLanguages
        for language in discoveredLanguages where !languages.contains(language) {
            languages.append(language)
        }
        if let language, languages.contains(language) {
            return NativeSpeechVoiceSelection(voiceIdentifier: nil, language: language)
        }

        let preferred = preferredLanguages.first { languages.contains($0) }
            ?? preferredLanguages.compactMap { preferredLanguage in
                let preferredCode = Locale(identifier: preferredLanguage)
                    .language.languageCode?.identifier
                return languages.first { candidate in
                    Locale(identifier: candidate).language.languageCode?.identifier
                        == preferredCode
                }
            }.first
        return NativeSpeechVoiceSelection(
            voiceIdentifier: nil,
            language: preferred ?? languages.first
        )
    }

    private static func areInIncreasingOrder(
        _ lhs: NativeSpeechVoiceDescriptor,
        _ rhs: NativeSpeechVoiceDescriptor
    ) -> Bool {
        if lhs.quality.sortRank != rhs.quality.sortRank {
            return lhs.quality.sortRank < rhs.quality.sortRank
        }
        if lhs.language != rhs.language {
            return lhs.language.localizedCaseInsensitiveCompare(rhs.language) == .orderedAscending
        }
        let nameOrder = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
        if nameOrder != .orderedSame {
            return nameOrder == .orderedAscending
        }
        return lhs.identifier.localizedCaseInsensitiveCompare(rhs.identifier) == .orderedAscending
    }
}
