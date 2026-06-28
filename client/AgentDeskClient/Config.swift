import Foundation

enum Config {
    static let signalingPort: UInt16 = 41888
    static let graphicsPort = graphicsPort(environment: ProcessInfo.processInfo.environment)
    // ADR-0019: plain-TCP port the iPhone listens on for a Mac-pushed pairing
    // offer. Must match the host's offer port.
    static let offerPort = offerPort(environment: ProcessInfo.processInfo.environment)
    // ADR-0020: wire protocol version negotiated at the session handshake. Bumped
    // only on a breaking wire change, independent of the marketing version. The
    // peer is rejected if its protocolVersion is below minCompatibleProtocolVersion.
    static let protocolVersion = 1
    static let minCompatibleProtocolVersion = 1
    static let keychainService = "com.example.agentdesk.AgentDeskClient"
    static let keychainAccessGroup: String? = nil
    static let storedPairingAccount = "session-token"
    static let graphicsReconnectInitialDelayMs = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_RECONNECT_INITIAL_DELAY_MS",
        defaultValue: 250
    )
    static let graphicsReconnectMaxDelayMs = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_RECONNECT_MAX_DELAY_MS",
        defaultValue: 2_000
    )
    static let graphicsReconnectMaxAttempts = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_RECONNECT_MAX_ATTEMPTS",
        defaultValue: 120
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

    static func graphicsPort(environment: [String: String]) -> UInt16 {
        guard let raw = environment["AGENTDESK_GRAPHICS_PORT"],
              let value = UInt16(raw),
              value > 0
        else {
            return 41_889
        }
        return value
    }

    static func offerPort(environment: [String: String]) -> UInt16 {
        guard let raw = environment["AGENTDESK_OFFER_PORT"],
              let value = UInt16(raw),
              value > 0
        else {
            return 41_890
        }
        return value
    }
}
