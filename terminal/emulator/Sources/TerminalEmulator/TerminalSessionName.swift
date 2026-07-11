import Foundation

enum TerminalSessionName {
    static func make(for cwd: URL, id: UUID = UUID()) -> String {
        let base = cwd.lastPathComponent.isEmpty ? "terminal" : cwd.lastPathComponent
        let cleaned = base
            .map { character -> Character in
                if character.isASCII,
                   character.isLetter || character.isNumber || character == "-" || character == "_" {
                    return character
                }
                return "-"
            }
            .reduce(into: "") { $0.append($1) }
            .trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
        let prefix = cleaned.isEmpty ? "terminal" : cleaned
        return "\(prefix)-\(id.uuidString.prefix(12))"
    }
}

