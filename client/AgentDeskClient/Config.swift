import Foundation

enum Config {
    static let signalingPort: UInt16 = 41888
    static let keychainService = "com.example.agentdesk.AgentDeskClient"
    static let keychainAccessGroup: String? = nil
    static let storedPairingAccount = "session-token"
}
