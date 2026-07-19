import Foundation

struct WorkspaceTerminalIdentity: Equatable, Sendable {
    static let namePrefix = "workspace-"
    static let suffixLength = 12

    let workspaceID: UUID

    var sessionNamePrefix: String {
        "\(Self.namePrefix)\(workspaceID.uuidString.lowercased())-"
    }

    func owns(sessionName: String) -> Bool {
        guard sessionName.hasPrefix(sessionNamePrefix) else { return false }
        let suffix = sessionName.dropFirst(sessionNamePrefix.count)
        return suffix.count == Self.suffixLength && suffix.allSatisfy(\.isHexDigit)
    }

    func makeSessionName(id: UUID = UUID()) -> String {
        let compactID = id.uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        return "\(sessionNamePrefix)\(compactID.prefix(Self.suffixLength))"
    }
}
