import Foundation

enum VoicePronunciationLexiconError: LocalizedError, Equatable {
    case unsupportedLocale(String)
    case unsupportedPhrase(String)
    case missingARPABETMapping(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedLocale(let locale):
            return "Phone analysis currently supports US English, not \(locale)."
        case .unsupportedPhrase(let phrase):
            return "No pinned CMUdict pronunciation is available for “\(phrase)”."
        case .missingARPABETMapping(let symbol):
            return "The pinned phone mapping does not cover CMUdict symbol \(symbol)."
        }
    }
}

enum VoicePronunciationLexicon {
    static let source = "CMUdict"
    static let sourceRevision = "74790861f652b15e4ac49015a90074ad62a27690"

    private static let entries: [String: [[String]]] = [
        "lice": [["L", "AY1", "S"]],
        "rice": [["R", "AY1", "S"]],
        "sheep": [["SH", "IY1", "P"]],
        "ship": [["SH", "IH1", "P"]],
        "sink": [["S", "IH1", "NG", "K"]],
        "think": [["TH", "IH1", "NG", "K"]],
        "very": [["V", "EH1", "R", "IY0"]],
        "wary": [["W", "EH1", "R", "IY0"]]
    ]

    private static let modelPhones: [String: String] = [
        "AY": "aɪ",
        "EH": "ɛ",
        "IH": "ɪ",
        "IY": "iː",
        "K": "k",
        "L": "l",
        "NG": "ŋ",
        "P": "p",
        "R": "ɹ",
        "S": "s",
        "SH": "ʃ",
        "TH": "θ",
        "V": "v",
        "W": "w"
    ]

    static func pronunciations(
        for phrase: String,
        localeIdentifier: String
    ) throws -> [VoiceTargetPronunciation] {
        let locale = Locale(identifier: localeIdentifier)
        guard locale.language.languageCode?.identifier == "en",
              locale.region?.identifier == "US"
        else {
            throw VoicePronunciationLexiconError.unsupportedLocale(localeIdentifier)
        }

        let word = phrase
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(with: Locale(identifier: "en-US"))
        guard word.split(whereSeparator: \.isWhitespace).count == 1,
              let variants = entries[word]
        else {
            throw VoicePronunciationLexiconError.unsupportedPhrase(phrase)
        }

        return try variants.map { symbols in
            let phones = try symbols.map { symbol in
                let unstressed = symbol.trimmingCharacters(in: .decimalDigits)
                guard let phone = modelPhones[unstressed] else {
                    throw VoicePronunciationLexiconError.missingARPABETMapping(symbol)
                }
                return phone
            }
            return VoiceTargetPronunciation(
                word: word,
                source: source,
                sourceRevision: sourceRevision,
                arpabet: symbols,
                phones: phones
            )
        }
    }
}
