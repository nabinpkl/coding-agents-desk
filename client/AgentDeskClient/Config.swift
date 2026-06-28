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
    // The stable and experimental client installs differ only by bundle id.
    // Deriving the log subsystem and keychain namespace from the running
    // bundle id keeps each variant's diagnostics and stored credentials
    // separate: `just iphone-log-collect` then filters one install's lines
    // (not both mixed), and the two apps never share keychain items. Falls
    // back to the stable id if the platform ever returns nil (it does not for
    // a real app bundle). For the stable build this resolves to the same
    // string as before, so behavior is unchanged.
    static let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.example.agentdesk.AgentDeskClient"
    static let logSubsystem = bundleIdentifier
    static let keychainService = bundleIdentifier
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
    // ADR-0025 datagram carrier: how long the client holds an incomplete motion
    // frame awaiting resends before dropping it and requesting a keyframe, how many
    // frames it tracks at once, and the cap on missing packets named per request.
    static let ownedMediaRepairDeadlineMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_REPAIR_DEADLINE_MS",
        defaultValue: 40
    )
    static let ownedMediaTrackedFrameLimit = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_TRACKED_FRAME_LIMIT",
        defaultValue: 8
    )
    static let ownedMediaMaxResendPackets = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MAX_RESEND_PACKETS",
        defaultValue: 64
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
