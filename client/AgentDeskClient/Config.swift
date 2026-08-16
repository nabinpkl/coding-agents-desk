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
    // How long the path must look unchanged before a post-handover redial trusts it. Covers the
    // stretch where a phone leaving WiFi still reports the dying interface as satisfied.
    static let sessionPathSettleDebounceMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_PATH_SETTLE_DEBOUNCE_MS",
        defaultValue: 400
    )
    // Cap on that wait. A path that never settles still has to be dialed over, and waiting
    // longer than the doomed dial used to cost would just trade one delay for another.
    static let sessionPathSettleTimeoutMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_PATH_SETTLE_TIMEOUT_MS",
        defaultValue: 2_000
    )
    static let sessionPathSettlePollMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_PATH_SETTLE_POLL_MS",
        defaultValue: 50
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
    // ADR-0104: how long the session may go with no inbound evidence before the client
    // manufactures some (a session-ping on the input lane). Anything arriving -- a datagram,
    // a push, a pong -- resets this, so an active session never pings.
    static let sessionQuietPingMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_QUIET_PING_MS",
        defaultValue: 2_000
    )
    // ADR-0104: the one number that ends a session for silence. Above the longest measured
    // self-healing stall (9s); inside the host's 20s resume TTL, so a success at the boundary
    // is still a resume rather than a re-pair. Counted across ALL carriers: redials do not
    // reset it, only evidence does.
    static let sessionSilenceLimitMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_SILENCE_LIMIT_MS",
        defaultValue: 15_000
    )
    // ADR-0104: how long a reattach may run before the overlay says anything. A carrier swap
    // that completes inside this is invisible -- which is most of them, now that a resume
    // costs a delta resync rather than an IDR.
    static let sessionReattachOverlayGraceMs = positiveInt(
        environmentKey: "AGENTDESK_SESSION_REATTACH_OVERLAY_GRACE_MS",
        defaultValue: 2_000
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
    // ADR-0027: how often the client reports link health (window completed/expired
    // frame counts) to the host adaptive bitrate controller. Each report carries that
    // window's counts, and at 2Hz it doubles as the traffic that keeps the QUIC idle
    // timer (~30s) from firing on a quiet carrier.
    static let ownedMediaLinkHealthIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_LINK_HEALTH_INTERVAL_MS",
        defaultValue: 500
    )
    // ADR-0073: minimum gap between recovery keyframe requests. Gap skips coalesce
    // behind one request; a later completed delta retries after this interval if the
    // recovery keyframe itself was lost.
    static let ownedMediaKeyframeRequestMinGapMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_KEYFRAME_REQUEST_MIN_GAP_MS",
        defaultValue: 300
    )
    // Gap-recovery escalation backstop. The gate normally resolves on the host's cheap answer
    // (a marked LTR-resync delta); if it has been armed this long and nothing resolved it, the
    // client's references are presumed unusable and the next request declares
    // `clientHasNoReferences`, buying one bounded IDR instead of an unbounded discard loop.
    //
    // A TIME window, sized for the answer's worst-case journey: a ~40KB refresh delta behind a
    // congested 180kbps link is ~2s of wire plus the smoothed ~700ms LTE round trip. The first
    // version counted discarded frames instead, which tied escalation to motion rate -- at
    // 14fps it fired in ~400ms and demanded 164KB IDRs into the very jam it was breaking (116
    // escalations in one 4-minute session).
    static let ownedMediaRecoveryEscalationMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RECOVERY_ESCALATION_MS",
        defaultValue: 4_000
    )
    // How long the datagram receive loop keeps retrying a throwing `receive()` before giving up.
    // Mirrors the host key of the same name; see `DatagramReceiveRetry` for why ending the loop
    // on the first error was wrong. Sized against the same two numbers: a ~6s measured LTE stall
    // and this client's own 6.5s silence verdict, both of which it must outlast.
    static let ownedMediaReceiveRetryBudgetMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RECEIVE_RETRY_BUDGET_MS",
        defaultValue: 30_000
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
