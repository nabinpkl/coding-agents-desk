import Foundation

enum Config {
    enum OwnedMediaChroma: String {
        case yuv420
        case yuv444
        case bgra

        init(rawEnvironmentValue: String?) {
            switch rawEnvironmentValue?.lowercased() {
            case "444", "yuv444", "4:4:4":
                self = .yuv444
            case "bgra":
                self = .bgra
            default:
                self = .yuv420
            }
        }
    }

    enum SpaceSwitchMode: String {
        case dockSwipe = "dock-swipe"
        case directSet = "direct-set"

        init(rawEnvironmentValue: String?) {
            switch rawEnvironmentValue?.lowercased() {
            case "direct-set", "direct_set", "directset":
                self = .directSet
            default:
                self = .dockSwipe
            }
        }
    }

    // Space Agent panel orientation. Vertical (default) stacks desktops in a
    // column to the left of the rocket; horizontal keeps the original strip
    // below it. Switch with AGENTDESK_SPACE_AGENT_LAYOUT = horizontal | vertical.
    enum SpaceAgentLayout: String {
        case horizontal
        case vertical

        init(rawEnvironmentValue: String?) {
            switch rawEnvironmentValue?.lowercased() {
            case "horizontal":
                self = .horizontal
            default:
                self = .vertical
            }
        }
    }

    static let signalingPort: UInt16 = 41888
    static let graphicsPort = graphicsPort(environment: ProcessInfo.processInfo.environment)
    // ADR-0019: dedicated plain-TCP port the Mac dials to push a pairing offer
    // to a chosen tailnet device. Separate from the TLS signaling port so the
    // offer path never touches the IP-literal-cert problem.
    static let offerPort = offerPort(environment: ProcessInfo.processInfo.environment)
    // ADR-0020: wire protocol version negotiated at the session handshake. Bumped
    // only on a breaking wire change, independent of the marketing version. The
    // peer is rejected if its protocolVersion is below minCompatibleProtocolVersion.
    static let protocolVersion = 1
    static let minCompatibleProtocolVersion = 1
    static let nonceTTL: TimeInterval = 90
    static let inputCapabilityTTL: TimeInterval = 60
    static let mediaCapabilityTTL: TimeInterval = 60
    static let ownedMediaChroma = OwnedMediaChroma(
        rawEnvironmentValue: ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_CHROMA"]
    )
    static let ownedMediaCaptureScaleDown = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CAPTURE_SCALE_DOWN",
        defaultValue: 1.0
    )
    static let ownedMediaBitrateKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BITRATE_KBPS",
        defaultValue: 8_000
    )
    static let ownedMediaExpectedFrameRate = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_FPS",
        defaultValue: 30
    )
    static let ownedMediaKeyframeIntervalFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_KEYFRAME_INTERVAL_FRAMES",
        defaultValue: 120
    )
    // ADR-0021: damage is emitted as tiles snapped to a fixed grid in surface
    // pixel space. A fixed cell size bounds per-tile bytes and gives each tile a
    // stable identity for the content tile cache (see the content-tile-cache
    // design and its ADR), instead of one variable-size tile over the damage union.
    static let hybridTileGridPx = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_TILE_GRID_PX",
        defaultValue: 128
    )
    // ADR-0021: backpressure is a simple in-flight cap. The producer holds at
    // most this many unacked graphics frames before it stalls. Stalled frames
    // coalesce in the mailbox, so the next produced frame carries the freshest
    // damage. This replaces the admission/floor/hysteresis/severe-mode layer.
    static let hybridMaxUnackedFrames = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_MAX_UNACKED_FRAMES",
        defaultValue: 2
    )
    static let hybridScrollInputPixelScale = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_INPUT_PIXEL_SCALE",
        defaultValue: 24
    )
    // How long a scroll input keeps the scroll hint active. The hint is what
    // lets the damage classifier attempt a copyRect instead of dumping the
    // frame to fullframe tiles. At 180 ms the hint expired between input events
    // and during post-gesture settling, so most frames of a real scroll saw no
    // hint and classified fullframe (device-run finding). Widen it to bridge the
    // whole gesture plus brief settling; surface validation still gates copyRect
    // so a stale-but-active hint cannot force a wrong copy.
    static let hybridScrollActiveWindowMs = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_ACTIVE_WINDOW_MS",
        defaultValue: 600
    )
    // JPEG quality for the fullframe fallback, motion-adaptive. A whole-screen
    // change ships as one lossy JPEG instead of multi-MB raw LZFSE (the fix for
    // the link saturation that froze the screen); small text-only changes still go
    // lossless LZFSE, so this lossy path only ever covers large motion.
    //
    // Rest quality is high so a settled screen is crisp. Motion quality is low: a
    // fullframe emitted while the scroll hint is active is mid-flick, where the eye
    // cannot resolve detail and a smaller frame holds cadence (less stepping). The
    // moment scrolling stops the hint lapses and the next settling frame lands at
    // rest quality, so the resting image self-sharpens.
    static let hybridFullframeJpegQuality = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_FULLFRAME_JPEG_QUALITY",
        defaultValue: 0.65
    )
    static let hybridFullframeJpegQualityMotion = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_FULLFRAME_JPEG_QUALITY_MOTION",
        defaultValue: 0.3
    )
    // Congestion quality: when the encode pump is backed up against the unacked
    // cap (a hard flick flooding fullframes faster than the link drains), encode at
    // this floor so each frame is tiny and drains fast, keeping cadence instead of
    // stalling into a freeze. This is RDP's P9 lesson, drop quality to hold cadence
    // under constrained bandwidth, applied as a congestion signal rather than a
    // fixed motion/rest split. Restored to motion/rest quality once the link drains.
    static let hybridFullframeJpegQualityCongested = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_FULLFRAME_JPEG_QUALITY_CONGESTED",
        defaultValue: 0.15
    )
    // Hard ceiling on a single fullframe JPEG's wire size. A whole-screen change at
    // Retina resolution was 0.9-2.0MB even as JPEG; one such frame clogged the
    // reliable channel long enough that a reset stripe's ack timed out, and the
    // resulting full-surface resync clogged it again, a self-feeding freeze
    // cascade (device run: gen 1->2, 15 disconnects). Capping every fullframe to a
    // drainable size keeps reset stripes (192KB each) flowing so the cascade cannot
    // form. The starting quality is stepped down until the JPEG fits this budget,
    // so a complex screen degrades gracefully instead of stalling the link.
    static let hybridFullframeMaxWireBytes = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_FULLFRAME_MAX_WIRE_BYTES",
        defaultValue: 450_000
    )
    // Congestion resolution scale: when the pump is backed up, the fullframe JPEG is
    // encoded at this fraction of the damage region's native size and the client
    // upscales it into the full destination rect. On a thin link JPEG quality alone
    // bottoms out (a whole-band JPEG of a Retina desktop is ~200KB even at the q0.15
    // floor), so halving the resolution cuts the encoded pixels ~4x and the wire
    // bytes with them, which is what actually lifts the frame rate when the link, not
    // the codec, is the limit. Softer during motion only; rest/motion fullframes stay
    // full resolution and the image re-sharpens the moment the link drains. 1.0
    // disables the downscale.
    static let hybridFullframeCongestedScale = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_FULLFRAME_CONGESTED_SCALE",
        defaultValue: 0.5
    )
    // Number of pump holds-since-last-produce that maps the instantaneous congestion
    // signal to 1.0 (fully saturated, encode at the floor). A device run showed the
    // pump holds ~2-3 frames per produce during a fullframe burst on a saturated
    // link, so this must be small: at 2, one held frame ramps the level to 0.5 (a
    // gentle quality dip, no downscale) and two or more piled-up frames reach the
    // floor, matching working-version-11's aggressive congestion response without
    // its cliff. A larger value (the first attempt used 8) left the level stuck near
    // 0.3, so fullframes stayed near rest quality and ballooned to ~370KB.
    static let hybridCongestionSaturationHolds = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_CONGESTION_SATURATION_HOLDS",
        defaultValue: 2
    )
    // EWMA smoothing for the congestion level so a single held frame does not jump the
    // level to maximum (the binary cliff that the macroblock regression came from).
    // new = alpha * instantaneous + (1 - alpha) * previous.
    static let hybridCongestionEwmaAlpha = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_CONGESTION_EWMA_ALPHA",
        defaultValue: 0.5
    )
    // Congestion level below which fullframe resolution stays full (scale 1.0). Above
    // it, scale ramps toward the congested floor. Resolution is the heavy hammer,
    // reserved for sustained congestion; quality does the gentle early work.
    static let hybridCongestionScaleRampThreshold = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_CONGESTION_SCALE_RAMP_THRESHOLD",
        defaultValue: 0.5
    )
    // Raw byte size (width*height*4) above which an exposed scroll strip is sent as
    // lossy JPEG instead of lossless LZFSE. A fast flick reveals a tall band that is a
    // large lossless blob (device run: ~133KB LZFSE strips); a slow scroll reveals a
    // thin strip that stays crisp and is small anyway. Congestion also forces lossy.
    static let hybridScrollStripLossyThresholdBytes = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_STRIP_LOSSY_THRESHOLD_BYTES",
        defaultValue: 524_288
    )
    static let hybridResetStripeMaxDecodedBytes = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_RESET_STRIPE_MAX_DECODED_BYTES",
        defaultValue: 2 * 1_024 * 1_024
    )
    static let hybridResetStripeMaxWireBytes = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_RESET_STRIPE_MAX_WIRE_BYTES",
        defaultValue: 196_608
    )
    static let hybridResetStripeAckTimeoutMs = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_RESET_STRIPE_ACK_TIMEOUT_MS",
        defaultValue: 1_000
    )
    // How many times the reset path re-waits for a stripe ack before declaring the
    // channel dead. A weak link can take several seconds to ack a reset stripe;
    // closing the channel on the first timeout re-syncs the whole surface and makes
    // a slow link worse, the freeze cascade (device run on far wifi: gen 1->2->3).
    // Retrying re-checks the connection each round, so a genuinely dead channel
    // still aborts within one timeout while a merely slow one is tolerated for the
    // full grace (attempts x timeout). A slow link is backpressure, not failure.
    static let hybridResetStripeAckMaxAttempts = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_RESET_STRIPE_ACK_MAX_ATTEMPTS",
        defaultValue: 6
    )
    static let hybridGraphicsFallbackMinIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_GRAPHICS_FALLBACK_MIN_INTERVAL_MS",
        defaultValue: 1_500
    )
    // Content tile cache: number of host/client-mirrored slots. Memory is
    // slots * maxCellBytes on each side; at 512 * 64*64*4 that is ~8 MB.
    static let hybridTileCacheSlots: Int = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_TILE_CACHE_SLOTS",
        defaultValue: 512
    )
    // Rung-3 busy-tile threshold. After LZFSE-compressing a new cache-miss cell,
    // divide the compressed byte count by the cell's pixel count (width * height).
    // If the result exceeds this value, the cell is "busy": photo or gradient
    // content that LZFSE cannot shrink, where JPEG costs far fewer bytes.
    // The cell is then re-encoded as JPEG at the current congestion quality/scale
    // and emitted as a cacheTile with compression: .jpeg instead of .lzfse.
    //
    // Calibration: each BGRA pixel is 4 raw bytes, so a completely uncompressed
    // LZFSE output is about 4 bytes/pixel. Random per-pixel noise approaches this
    // ceiling (LZFSE inflates by ~5% for incompressible data). Solid-color and
    // text content compresses well under 1 byte/pixel. Setting the threshold at
    // 2.0 bpp sits cleanly between these poles: text and UI tiles stay LZFSE
    // (well under 1 bpp), and near-incompressible photo/gradient tiles exceed
    // 2 bpp and cross over to JPEG. 2.0 is a safe conservative choice: no real
    // text tile reaches it, and any photo that compresses poorly is already in
    // the regime where lossy JPEG quality is accepted (same path as the
    // fullframe fallback). Override with AGENTDESK_HYBRID_TILE_BUSY_BYTES_PER_PIXEL.
    static let hybridTileBusyBytesPerPixel: Double = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_TILE_BUSY_BYTES_PER_PIXEL",
        defaultValue: 2.0
    )
    // Per-frame payload byte budget for the tiler. A genuinely-new busy screen
    // (app switch, photo wall) tiled all-LZFSE could sum to several MB and clog
    // the ~2Mbps reliable channel, the exact freeze the fullframe-JPEG fallback
    // existed to prevent. The tiler accumulates appended payload bytes across
    // cells; once the running total crosses this budget, every subsequent rung-3
    // (new) cell is forced to JPEG at congestion quality/scale regardless of the
    // per-cell busy test, bounding a brand-new fullframe to roughly one JPEG's
    // cost. Cells that hit rung 1 (omitted) or rung 2 (drawCachedTile) carry no
    // payload and never count toward the budget, so a mostly-cached screen stays
    // free no matter how large.
    //
    // Calibration: the link is ~2Mbps ~= 250KB/s. The old whole-frame JPEG
    // fallback landed near ~338KB per fullframe and was already drainable enough
    // to hold cadence (about one frame per 1.3s at the floor). 300KB sits just
    // under that, so a worst-case all-new busy fullframe costs about one old JPEG
    // while a text-heavy fullframe (LZFSE well under budget) stays fully lossless
    // and crisp. Override with AGENTDESK_HYBRID_FRAME_BYTE_BUDGET.
    static let hybridFrameByteBudget: Int = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_FRAME_BYTE_BUDGET",
        defaultValue: 300_000
    )
    // Kill switch; false falls back to rung-1 baseline skip only.
    static let hybridTileCacheEnabled: Bool = enabledFlag(
        environmentKey: "AGENTDESK_HYBRID_TILE_CACHE_ENABLED",
        defaultValue: true,
        environment: ProcessInfo.processInfo.environment
    )
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
    static func positiveInt(environmentKey: String, defaultValue: Int) -> Int {
        guard let raw = ProcessInfo.processInfo.environment[environmentKey],
              let value = Int(raw),
              value > 0
        else {
            return defaultValue
        }
        return value
    }
    static func positiveDouble(environmentKey: String, defaultValue: Double) -> Double {
        positiveDouble(
            environment: ProcessInfo.processInfo.environment,
            environmentKey: environmentKey,
            defaultValue: defaultValue
        )
    }
    static func positiveDouble(
        environment: [String: String],
        environmentKey: String,
        defaultValue: Double
    ) -> Double {
        guard let raw = environment[environmentKey],
              let value = Double(raw),
              value > 0
        else {
            return defaultValue
        }
        return value
    }
    static func nonNegativeInt(environmentKey: String, defaultValue: Int) -> Int {
        guard let raw = ProcessInfo.processInfo.environment[environmentKey],
              let value = Int(raw),
              value >= 0
        else {
            return defaultValue
        }
        return value
    }
    static func enabledFlag(
        environmentKey: String,
        defaultValue: Bool,
        environment: [String: String]
    ) -> Bool {
        guard let raw = environment[environmentKey]?.lowercased() else {
            return defaultValue
        }
        switch raw {
        case "1", "true", "yes", "on":
            return true
        case "0", "false", "no", "off":
            return false
        default:
            return defaultValue
        }
    }
    static let gestureChildExecutableURL: URL? = {
        guard let raw = ProcessInfo.processInfo.environment["AGENTDESK_GESTURE_CHILD_PATH"],
              !raw.isEmpty
        else {
            return nil
        }
        return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath)
    }()
    static let gestureChildArguments: [String] = {
        guard let raw = ProcessInfo.processInfo.environment["AGENTDESK_GESTURE_CHILD_ARGS"],
              !raw.isEmpty
        else {
            return []
        }
        return raw.split(separator: " ").map(String.init)
    }()
    static let voiceChildExecutableURL: URL? = {
        guard let raw = ProcessInfo.processInfo.environment["AGENTDESK_VOICE_CHILD_PATH"],
              !raw.isEmpty
        else {
            return nil
        }
        return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath)
    }()
    static let voiceChildArguments: [String] = {
        guard let raw = ProcessInfo.processInfo.environment["AGENTDESK_VOICE_CHILD_ARGS"],
              !raw.isEmpty
        else {
            return []
        }
        return raw.split(separator: " ").map(String.init)
    }()
    static let spaceAgentLayout = SpaceAgentLayout(
        rawEnvironmentValue: ProcessInfo.processInfo.environment["AGENTDESK_SPACE_AGENT_LAYOUT"]
    )
    // Experimental local-only switch backend. Default stays on the
    // stock Dock-swipe path; direct-set is for HITL diagnostics around
    // private SkyLight behavior.
    static let spaceSwitchMode = SpaceSwitchMode(
        rawEnvironmentValue: ProcessInfo.processInfo.environment["AGENTDESK_SPACE_SWITCH_MODE"]
    )
    // Host-local transcription service, OpenAI-compatible. The clip never
    // touches disk; it is POSTed as multipart/form-data (fields "file" and
    // "model") from an in-memory WAV buffer. Required: set
    // AGENTDESK_TRANSCRIBE_URL (see .env.example). There is no baked-in
    // default, so an unset or malformed URL leaves this nil and dictation
    // fails loudly rather than silently POSTing at a host that may not exist.
    static let transcriptionEndpoint: URL? = {
        guard let raw = ProcessInfo.processInfo.environment["AGENTDESK_TRANSCRIBE_URL"],
              let url = URL(string: raw),
              url.scheme != nil
        else {
            return nil
        }
        return url
    }()
    // Model name sent in the multipart body for OpenAI-compatible servers.
    // Servers that ignore the field are unaffected.
    static let transcriptionModel: String = {
        ProcessInfo.processInfo.environment["AGENTDESK_TRANSCRIBE_MODEL"] ?? "mlx-community/whisper-large-v3-turbo"
    }()
    // App driven by the terminal-launcher pill. Defaults to Ghostty, whose
    // quick terminal (quake-style drop-down) the pill toggles by activating the
    // app and synthesizing its quick-terminal chord. Override the app with
    // AGENTDESK_TERMINAL_APP (a path to a .app).
    static let terminalAppURL: URL = {
        if let raw = ProcessInfo.processInfo.environment["AGENTDESK_TERMINAL_APP"],
           !raw.isEmpty {
            return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath)
        }
        return URL(fileURLWithPath: "/Applications/Ghostty.app")
    }()
    // Bundle identifier of the terminal app, used to find a running instance to
    // activate before sending the toggle chord. Defaults to Ghostty; override
    // with AGENTDESK_TERMINAL_BUNDLE_ID to match a custom AGENTDESK_TERMINAL_APP.
    static let terminalBundleID: String = {
        if let raw = ProcessInfo.processInfo.environment["AGENTDESK_TERMINAL_BUNDLE_ID"],
           !raw.isEmpty {
            return raw
        }
        return "com.mitchellh.ghostty"
    }()
    static let launchAgentLabel = "com.example.agentdesk.AgentDeskHost"
    static let applicationSupportDirectory = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("AgentDesk", isDirectory: true)
    static let pairedDevicesURL = applicationSupportDirectory
        .appendingPathComponent("paired-devices.json", isDirectory: false)
    static let adSocketURL = applicationSupportDirectory
        .appendingPathComponent("ad.sock", isDirectory: false)
    static let adTokenURL = applicationSupportDirectory
        .appendingPathComponent("ad-token", isDirectory: false)
    static let devLastPairURLPath = applicationSupportDirectory
        .appendingPathComponent(".last-pair-url", isDirectory: false)
    static let tlsCertURL = applicationSupportDirectory
        .appendingPathComponent("host.crt", isDirectory: false)
    static let tlsKeyURL = applicationSupportDirectory
        .appendingPathComponent("host.key", isDirectory: false)
    static let tlsIdentityURL = applicationSupportDirectory
        .appendingPathComponent("host.p12", isDirectory: false)
    static var launchAgentPlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(launchAgentLabel).plist")
    }
    static var hostExecutableURL: URL {
        URL(fileURLWithPath: Bundle.main.executablePath ?? "")
    }
    static let keychainService = "com.example.agentdesk.AgentDeskHost"
    static let hostSigningKeyAccount = "host-signing-key"
    static let keychainAccessGroup: String? = nil
    static let devHostSigningKeyFile = applicationSupportDirectory
        .appendingPathComponent("host-signing-key.dev", isDirectory: false)
}
