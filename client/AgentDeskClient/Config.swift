import Foundation

enum Config {
    static let signalingPort: UInt16 = 41888
    static let keychainService = "com.example.agentdesk.AgentDeskClient"
    static let keychainAccessGroup: String? = nil
    static let storedPairingAccount = "session-token"
    static let ownedMediaRepairDeadlineMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_REPAIR_DEADLINE_MS",
        defaultValue: 50
    )
    static let ownedMediaResendRingFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RESEND_RING_FRAMES",
        defaultValue: 8
    )
    static let ownedMediaMaxResendPackets = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MAX_RESEND_PACKETS",
        defaultValue: 256
    )

    static func positiveInt(environmentKey: String, defaultValue: Int) -> Int {
        guard let raw = ProcessInfo.processInfo.environment[environmentKey],
              let value = Int(raw),
              value > 0
        else {
            return defaultValue
        }
        return value
    }
}
