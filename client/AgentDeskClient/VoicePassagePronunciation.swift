import CryptoKit
import Foundation

struct VoicePassagePronunciationResult: Codable, Equatable, Sendable {
    let words: [String]
    let wordPronunciations: [VoicePassageWordPronunciation]
    let phones: [String]
    let unknownWords: [String]

    var displayText: String {
        guard !phones.isEmpty else {
            return unknownWords.isEmpty
                ? "Edit the transcript to generate reference phonemes."
                : "No reference phonemes are available."
        }
        return phones.joined(separator: "  ")
    }
}

enum VoicePassagePronunciationError: LocalizedError, Equatable {
    case missingDictionary
    case dictionaryHashMismatch
    case unreadableDictionary
    case missingARPABETMapping(String)

    var errorDescription: String? {
        switch self {
        case .missingDictionary:
            return "The bundled CMU pronunciation dictionary is missing."
        case .dictionaryHashMismatch:
            return "The bundled CMU pronunciation dictionary does not match its pinned revision."
        case .unreadableDictionary:
            return "The bundled CMU pronunciation dictionary could not be read."
        case .missingARPABETMapping(let symbol):
            return "The phone mapping does not cover CMUdict symbol \(symbol)."
        }
    }
}

actor VoicePassagePronouncer {
    static let dictionarySHA256 =
        "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22"

    private let dictionaryURL: URL?
    private var entries: [String: [String]]?

    init(bundle: Bundle = .main) {
        dictionaryURL = bundle.url(
            forResource: "VoiceCMUDictionary",
            withExtension: "txt"
        )
    }

    init(dictionaryURL: URL?) {
        self.dictionaryURL = dictionaryURL
    }

    func pronunciation(
        for transcript: String
    ) throws -> VoicePassagePronunciationResult {
        try Self.pronunciation(
            for: transcript,
            entries: loadEntries()
        )
    }

    static func pronunciation(
        for transcript: String,
        entries: [String: [String]]
    ) throws -> VoicePassagePronunciationResult {
        let words = words(in: transcript)
        guard !words.isEmpty else {
            return VoicePassagePronunciationResult(
                words: [],
                wordPronunciations: [],
                phones: [],
                unknownWords: []
            )
        }

        var wordPronunciations: [
            VoicePassageWordPronunciation
        ] = []
        var unknownWords: [String] = []
        for word in words {
            guard let symbols = entries[word] else {
                unknownWords.append(word)
                wordPronunciations.append(
                    VoicePassageWordPronunciation(
                        word: word,
                        phones: [],
                        isKnown: false
                    )
                )
                continue
            }
            var wordPhones: [String] = []
            for symbol in symbols {
                guard let phone = VoiceARPABETPhoneMapping.modelPhone(
                    for: symbol
                ) else {
                    throw VoicePassagePronunciationError
                        .missingARPABETMapping(symbol)
                }
                wordPhones.append(phone)
            }
            wordPronunciations.append(
                VoicePassageWordPronunciation(
                    word: word,
                    phones: wordPhones,
                    isKnown: true
                )
            )
        }
        return VoicePassagePronunciationResult(
            words: words,
            wordPronunciations: wordPronunciations,
            phones: wordPronunciations.flatMap(\.phones),
            unknownWords: Array(Set(unknownWords)).sorted()
        )
    }

    private func loadEntries() throws -> [String: [String]] {
        if let entries {
            return entries
        }
        guard let dictionaryURL else {
            throw VoicePassagePronunciationError.missingDictionary
        }
        let data: Data
        do {
            data = try Data(contentsOf: dictionaryURL, options: .mappedIfSafe)
        } catch {
            throw VoicePassagePronunciationError.unreadableDictionary
        }
        let hash = SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
        guard hash == Self.dictionarySHA256 else {
            throw VoicePassagePronunciationError.dictionaryHashMismatch
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw VoicePassagePronunciationError.unreadableDictionary
        }
        let parsed = Self.parseDictionary(text)
        guard !parsed.isEmpty else {
            throw VoicePassagePronunciationError.unreadableDictionary
        }
        entries = parsed
        return parsed
    }

    static func words(in transcript: String) -> [String] {
        let lowered = transcript.lowercased(with: Locale(identifier: "en-US"))
        let scalars = lowered.unicodeScalars.map { scalar -> Character in
            if CharacterSet.letters.contains(scalar) || scalar == "'" {
                return Character(String(scalar))
            }
            return " "
        }
        return String(scalars)
            .split(whereSeparator: \.isWhitespace)
            .map(String.init)
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "'")) }
            .filter { !$0.isEmpty }
    }

    static func parseDictionary(_ text: String) -> [String: [String]] {
        var result: [String: [String]] = [:]
        result.reserveCapacity(130_000)
        for line in text.split(whereSeparator: \.isNewline) {
            let fields = line.split(whereSeparator: \.isWhitespace)
            guard fields.count > 1 else { continue }
            let rawWord = String(fields[0])
            let word = rawWord.replacingOccurrences(
                of: #"\(\d+\)$"#,
                with: "",
                options: .regularExpression
            )
            .lowercased(with: Locale(identifier: "en-US"))
            guard result[word] == nil else { continue }
            result[word] = fields.dropFirst().map(String.init)
        }
        return result
    }
}
