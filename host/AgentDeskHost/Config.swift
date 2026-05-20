import Foundation

enum Config {
    static let signalingPort: UInt16 = 41888
    static let nonceTTL: TimeInterval = 90
    static let applicationSupportDirectory = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("AgentDesk", isDirectory: true)
    static let pairedDevicesURL = applicationSupportDirectory
        .appendingPathComponent("paired-devices.json", isDirectory: false)
    static let keychainService = "com.example.agentdesk.AgentDeskHost"
    static let hostSigningKeyAccount = "host-signing-key"
    static let keychainAccessGroup: String? = nil
}
