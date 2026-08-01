import Foundation
import AgentDeskWire

enum Config {
    static let sessionQuicALPN = WireProtocol.sessionQuicALPN
    // ADR-0019: plain-TCP port the iPhone listens on for a Mac-pushed pairing
    // offer. Tier-derived (see Tier below) so the dev client listens on the dev
    // block and the same-tier dev host dials it; a full dev stack then runs beside
    // the stable stack. The host's signaling port is not hardcoded on the client:
    // it is learned from the offer (PairingPayload.signalingPort) and dialed directly.
    static let offerPort = port(
        environmentKey: "AGENTDESK_OFFER_PORT",
        defaultValue: tieredPort(stable: 41_890, dev: 41_990)
    )
    // ADR-0020: wire protocol version negotiated at the session handshake. Bumped
    // only on a breaking wire change, independent of the marketing version. The
    // peer is rejected if its protocolVersion is below minCompatibleProtocolVersion.
    static let protocolVersion = WireProtocol.version
    static let minCompatibleProtocolVersion = WireProtocol.minCompatibleVersion
    // Overall budget for a dial to reach .ready, covering the states that mean progress
    // (.setup, .preparing) plus any short .waiting stretches along the way.
    static let sessionConnectionReadyTimeoutMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_CONNECTION_READY_TIMEOUT_MS",
        defaultValue: 10_000
    )
    // How long a dial may sit *blocked* in .waiting before we abandon it for a fresh one.
    //
    // Much shorter than the overall budget because .waiting does not mean "nearly there": it
    // is Network.framework reporting that the connection cannot proceed and will retry when
    // conditions change. Measured on a real dial, a blocked connection does not recover when
    // conditions do -- one sat in waiting(ENETDOWN) for 11.7s while a connection opened fresh
    // against the same host went ready in 70ms, and it then died with ECONNREFUSED rather
    // than catching up. Waiting out the full budget bought nothing; the redial was both
    // cheaper and the thing that worked.
    //
    // Still seconds rather than milliseconds because .waiting can appear transiently just
    // before .ready (notably simulator loopback QUIC). Leaving .waiting cancels the bound, so
    // a blip costs nothing, and observed successful dials on a linkQuality=minimal cellular
    // path reached .ready well inside it.
    static let sessionConnectionWaitingTimeoutMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_CONNECTION_WAITING_TIMEOUT_MS",
        defaultValue: 2_000
    )
    // How many times a pairing dial redials itself after coming up blocked, before falling back
    // to one patient attempt. Pairing has no retry loop above it, so it owns this; sessions do
    // not need it because the reconnect loop already redials.
    static let pairingBlockedDialRetries = positiveInt(
        environmentKey: "AGENTDESK_PAIRING_BLOCKED_DIAL_RETRIES",
        defaultValue: 2
    )
    static let sessionReconnectRetryDelayMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_RECONNECT_RETRY_DELAY_MS",
        defaultValue: 1_000
    )
    // ADR-0058: grace before an unconfirmed locally predicted cursor becomes
    // a grey ghost. This is intentionally longer than normal input-lane RTT,
    // while still surfacing a host that stopped applying cursor input quickly.
    static let cursorConfirmationTimeoutMs = positiveInt(
        environmentKey: "AGENTDESK_CURSOR_CONFIRMATION_TIMEOUT_MS",
        defaultValue: 250
    )
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
    // Build tier, derived from the bundle id (not a runtime flag), mirroring the
    // host. The dev client listens for offers on the dev port block so it pairs
    // with the same-tier dev host while the stable stack keeps running. The dev
    // block is the stable port + 100.
    enum Tier {
        case stable
        case dev
    }
    static let tier: Tier = bundleIdentifier.hasSuffix(".dev") ? .dev : .stable
    static func tieredPort(stable: UInt16, dev: UInt16) -> UInt16 {
        tier == .dev ? dev : stable
    }
    static let keychainAccessGroup: String? = nil
    static let storedPairingAccount = "session-token"
    static let applicationSupportDirectory = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("AgentDesk", isDirectory: true)
    static let diagnosticsDirectory = applicationSupportDirectory
        .appendingPathComponent("Diagnostics", isDirectory: true)
    static let workspaceIDEDraftsDirectory = applicationSupportDirectory
        .appendingPathComponent("WorkspaceIDE/Drafts", isDirectory: true)
    static let voiceAttemptsDirectory = applicationSupportDirectory
        .appendingPathComponent("VoiceAttempts", isDirectory: true)
    static let voicePassageRecordingsDirectory = applicationSupportDirectory
        .appendingPathComponent("VoicePassageRecordings", isDirectory: true)
    static let diagnosticsManifestURL = diagnosticsDirectory
        .appendingPathComponent("manifest.json", isDirectory: false)
    static let diagnosticsCurrentRunURL = diagnosticsDirectory
        .appendingPathComponent("current.ndjson", isDirectory: false)
    static let diagnosticsMaxEventBytes = 8 * 1024
    static let diagnosticsMaxRunBytes = 2 * 1024 * 1024
    static let diagnosticsMaxTotalBytes = 6 * 1024 * 1024
    static let diagnosticsMaxRuns = 3
    static let diagnosticsMaxResponseBytes = 768 * 1024
    static let diagnosticsMaxChunkEncodedBytes = 48 * 1024
    static let diagnosticsAuthMaxSkewSeconds = 60
    static let diagnosticsAuthNonceCacheLimit = 256
    static let screenshotMaxPixelDimension = 2_048
    static let screenshotMaxBytes = 4 * 1_024 * 1_024
    static let screenshotChunkBytes = 256 * 1_024
    static let screenshotOfferPortChunkBytes = 32 * 1_024
    static let screenshotJPEGQuality: CGFloat = 0.85
    static let screenshotMinimumIntervalSeconds: TimeInterval = 3
    static let diagnosticsMediaSummaryIntervalNs: UInt64 = 1_000_000_000
    // One-shot validation override. Unlike the durable AGENTDESK_OWNED_MEDIA_*
    // knobs, this never persists or mutates the user's settings. The physical
    // motion recipe uses it to prove an exact fixed profile instead of silently
    // inheriting whatever manual values were last selected on the phone.
    static let launchMediaQualityOverride = fixedMediaQualityOverride(
        environment: ProcessInfo.processInfo.environment
    )
    static let ownedMediaExpectedFrameRate = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_EXPECTED_FRAME_RATE",
        defaultValue: 30
    )
    // ADR-0073 datagram carrier: incomplete frames have no presentation deadline.
    // This bounds pending assemblies and the number of missing packets named in one
    // opportunistic resend request.
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
    // ADR-0027: how often the client reports link health (window completed/expired
    // frame counts) to the host adaptive bitrate controller. Faster than keepalive so
    // the controller reacts within a second; each report carries that window's counts.
    static let ownedMediaLinkHealthIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_LINK_HEALTH_INTERVAL_MS",
        defaultValue: 500
    )
    // ADR-0089 handover recovery: how long a detected link change is given to start carrying
    // traffic again before the session is declared dead and re-dialed.
    //
    // Sized from the device measurement rather than taste. Detection fires within one report
    // window (~0.5s); the measured freeze delivered nothing for 9s and the transport never
    // reported a failure at all. 2s recovers roughly four times sooner than that freeze
    // self-healed while still leaving a real handover time to settle, and it sits far inside
    // the host's 20s resume window, so the resume material is still valid when we dial.
    static let ownedMediaHandoverGraceMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_HANDOVER_GRACE_MS",
        defaultValue: 2000
    )
    // ADR-0089 liveness: how often the client probes the host while nothing is arriving.
    //
    // Only spent when the downlink is already silent, so an active session pays nothing and an
    // idle one pays one small datagram each way per interval. The radio is awake anyway -- the
    // link-health report goes out at 2Hz -- so this adds bandwidth, not wakeups.
    static let ownedMediaLivenessProbeIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_LIVENESS_PROBE_INTERVAL_MS",
        defaultValue: 2000
    )
    // ADR-0089 liveness: unanswered probes before the downlink is declared dead.
    //
    // Three at a 2s interval declares roughly 6.5s after the last arrival: sooner than the 9.6s
    // the transport took to notice the same death in R212, and far inside the host's 20s resume
    // window so the session can be resumed rather than re-paired. Not lower, because a single
    // lost datagram must never fire this -- three consecutive round trips lost at the 0.2% loss
    // measured at rest is about one in ten million.
    static let ownedMediaLivenessFailureThreshold = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_LIVENESS_FAILURE_THRESHOLD",
        defaultValue: 3
    )
    // ADR-0073: minimum gap between recovery keyframe requests. Gap skips coalesce
    // behind one request; a later completed delta retries after this interval if the
    // recovery keyframe itself was lost.
    static let ownedMediaKeyframeRequestMinGapMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_KEYFRAME_REQUEST_MIN_GAP_MS",
        defaultValue: 300
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
    // ADR-0030: video datagrams ride the authenticated session QUIC connection.

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

    static func fixedMediaQualityOverride(
        environment: [String: String]
    ) -> ClientMediaQualityConfig? {
        guard let raw = environment["AGENTDESK_CLIENT_FIXED_MEDIA_PROFILE"] else {
            return nil
        }
        let components = raw.split(separator: ",", omittingEmptySubsequences: false)
        precondition(
            components.count == 3,
            "AGENTDESK_CLIENT_FIXED_MEDIA_PROFILE must be bitrateKbps,fps,resolutionScale"
        )
        guard let bitrateKbps = Int(components[0]),
              let fps = Int(components[1]),
              let resolutionScale = Double(components[2]),
              bitrateKbps > 0,
              fps > 0,
              resolutionScale > 0,
              resolutionScale <= 1
        else {
            preconditionFailure(
                "AGENTDESK_CLIENT_FIXED_MEDIA_PROFILE must contain positive bitrate/fps and scale in (0,1]"
            )
        }
        return ClientMediaQualityConfig(
            adaptiveEnabled: false,
            fixedTarget: ClientMediaQualityTarget(
                bitrateKbps: bitrateKbps,
                fps: fps,
                resolutionScale: resolutionScale
            )
        )
    }

    // The agent-feed webview is now owned by the reusable AgentPanel package
    // (`AgentPanelResourceLocator` resolves it from the package's own bundle), so
    // the former `agentFeedWebview*` config accessors have been removed. The
    // `AgentFeedWebview` bundle folder is likewise vestigial and can be dropped in
    // a follow-up build-phase cleanup.

}
