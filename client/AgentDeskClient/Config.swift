import Foundation

enum Config {
    static let signalingPort: UInt16 = 41888
    static let graphicsPort = port(environmentKey: "AGENTDESK_GRAPHICS_PORT", defaultValue: 41_889)
    // ADR-0019: plain-TCP port the iPhone listens on for a Mac-pushed pairing
    // offer. Must match the host's offer port.
    static let offerPort = port(environmentKey: "AGENTDESK_OFFER_PORT", defaultValue: 41_890)
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
        defaultValue: 50
    )
    static let ownedMediaTrackedFrameLimit = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_TRACKED_FRAME_LIMIT",
        defaultValue: 8
    )
    static let ownedMediaMaxResendPackets = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MAX_RESEND_PACKETS",
        defaultValue: 256
    )
    // ADR-0027 render-stall watchdog. The carrier can wedge: frames keep arriving but
    // the decoder stops presenting (a delta decoded against a reference lost to packet
    // drop leaves AVSampleBufferDisplayLayer failed). When frames are arriving (host is
    // sending) but none have enqueued for this long, the sink flushes and asks for a
    // fresh keyframe to resync, rate-limited to once per this interval. A quiet host
    // (rest, or a dead link) shows no recent arrivals and does not trigger it.
    static let ownedMediaRenderStallMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RENDER_STALL_MS",
        defaultValue: 1_000
    )
    // ADR-0025 carrier keepalive cadence. The datagram carrier is host->client only,
    // so with nothing flowing back the host's QUIC idle timer fires (~30s) and drops
    // the carrier. A small keepalive control datagram on this interval keeps the host
    // hearing from the client. Must stay well under the 30s idle window.
    static let ownedMediaKeepaliveIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_KEEPALIVE_INTERVAL_MS",
        defaultValue: 5_000
    )
    // ADR-0025 motion carrier switch (mirrors the host). ON by default now that the
    // video path is device-validated: the client accepts the HEVC datagram stream and
    // renders the video layer. Set the env var to 0/false to render only the retained
    // tile path. An absent value resolves to true (the baked default).
    static let ownedMediaVideoMotionEnabled: Bool = {
        switch resolvedEnvValue("AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED")?.lowercased() {
        case "0", "false", "no", "off": return false
        default: return true
        }
    }()
    static let ownedMediaMaxDatagramFrameSize = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MAX_DATAGRAM_FRAME_SIZE",
        defaultValue: 1300
    )
    // ADR-0025 motion carrier: the host's dedicated QUIC datagram listener port. The
    // client opens an isDatagram connection here for the HEVC video. Must match the
    // host's AGENTDESK_OWNED_MEDIA_DATAGRAM_PORT.
    static let ownedMediaDatagramPort = port(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DATAGRAM_PORT",
        defaultValue: 41_891
    )

    // MARK: - Durable env config
    //
    // A value injected via the process environment (a recipe / devicectl dev launch)
    // is persisted to UserDefaults, so a later launch from the home-screen icon, which
    // carries no environment, reapplies the same config instead of snapping back to
    // defaults. This is the bug behind "reopened the app and motion was gone": with no
    // env, ownedMediaVideoMotionEnabled fell back to false and the client stopped
    // accepting the carrier even while the host kept producing it.
    //
    // Resolution order: env (wins, and refreshes the stored value) -> last persisted
    // value -> hardcoded default. UserDefaults is per-bundle-id, so the dev variant's
    // persistence never leaks into the stable daily driver. The pairing / launch URL is
    // read straight from the environment elsewhere (SceneDelegate), not through here,
    // so it stays a one-shot and is never persisted.
    private static let durableKeyPrefix = "config.durable."

    static func resolvedEnvValue(_ key: String) -> String? {
        // UserDefaults.standard is thread-safe and accessed inline (not held as a
        // static, which Swift 6 rejects as non-Sendable shared mutable state).
        let store = UserDefaults.standard
        if let raw = ProcessInfo.processInfo.environment[key] {
            store.set(raw, forKey: durableKeyPrefix + key)
            return raw
        }
        return store.string(forKey: durableKeyPrefix + key)
    }

    static func positiveInt(environmentKey: String, defaultValue: Int) -> Int {
        guard let raw = resolvedEnvValue(environmentKey),
              let value = Int(raw),
              value > 0
        else {
            return defaultValue
        }
        return value
    }

    static func port(environmentKey: String, defaultValue: UInt16) -> UInt16 {
        guard let raw = resolvedEnvValue(environmentKey),
              let value = UInt16(raw),
              value > 0
        else {
            return defaultValue
        }
        return value
    }

}
