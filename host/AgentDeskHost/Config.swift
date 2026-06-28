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

    // ADR-0025 motion carrier mode, layered on the video carrier. `.alwaysVideo` is
    // the default now that device validation showed video alone is smooth, responsive,
    // and cheap at rest: the carrier runs on every produced frame and never paints
    // tiles. `.tilesMotion` is the prior hybrid: video on scroll, crisp tiles at rest;
    // opt into it with AGENTDESK_OWNED_MEDIA_MOTION_MODE = tiles_motion. No combo/repair
    // mode exists yet, so an unrecognized value resolves to the `.alwaysVideo` default.
    enum OwnedMediaMotionMode: String {
        case tilesMotion
        case alwaysVideo

        init(rawEnvironmentValue: String?) {
            switch rawEnvironmentValue?.trimmingCharacters(in: .whitespaces).lowercased() {
            case "tiles_motion", "tiles+motionvideo", "tiles", "scroll":
                self = .tilesMotion
            default:
                self = .alwaysVideo
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
    // The adaptive controller's ceiling and starting target (ADR-0027). Lowered from
    // 8000 to 2500 after device testing: a full-screen Retina text keyframe is
    // content-bound near 140KB regardless, so 8000 bought no text-quality benefit and
    // only saturated constrained links. The controller oscillates between
    // ownedMediaBitrateFloorKbps and this ceiling.
    static let ownedMediaBitrateKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BITRATE_KBPS",
        defaultValue: 2_500
    )
    // ADR-0027 adaptive bitrate controller knobs. Down fast on loss, up slow on a
    // clean streak; see VideoBitrateController.
    static let ownedMediaBitrateFloorKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BITRATE_FLOOR_KBPS",
        defaultValue: 800
    )
    static let ownedMediaBitrateDownStep = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BITRATE_DOWN_STEP",
        defaultValue: 0.7
    )
    static let ownedMediaBitrateUpStep = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BITRATE_UP_STEP",
        defaultValue: 1.15
    )
    // Window loss ratio in per mille (parts per thousand) at or above which the
    // controller steps the bitrate down. 50 = 5 percent of frames lost past repair.
    static let ownedMediaBitrateLossDownPermille = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BITRATE_LOSS_DOWN_PERMILLE",
        defaultValue: 50
    )
    // Consecutive clean report windows required before the controller steps up.
    static let ownedMediaBitrateRaiseCleanWindows = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BITRATE_RAISE_CLEAN_WINDOWS",
        defaultValue: 4
    )
    // ADR-0027: hard data-rate ceiling as a multiple of the average bitrate.
    // AverageBitRate only bounds the long-run average, so a single keyframe can
    // burst many times the target in one frame; on a constrained link that burst is
    // what freezes. The encoder sets kVTCompressionPropertyKey_DataRateLimits to a
    // one-second window at this multiple of the average byte-rate, forcing the
    // keyframe to compress to fit the link instead of bursting. 1.5 gives keyframes
    // 50 percent headroom over the nominal rate. Tracks the bitrate, so lowering the
    // bitrate lowers the cap with it.
    static let ownedMediaDataRateLimitRatio = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DATA_RATE_LIMIT_RATIO",
        defaultValue: 1.5
    )
    static let ownedMediaExpectedFrameRate = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_FPS",
        defaultValue: 30
    )
    // Tile-path periodic full-surface heal cadence (ScrollDeltaEngine.healIntervalFrames).
    // Named for the heal it actually drives, not a video keyframe. The video GOP is the
    // separate ownedMediaKeyframeIntervalFrames below.
    static let ownedMediaTileHealIntervalFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_TILE_HEAL_INTERVAL_FRAMES",
        defaultValue: 120
    )
    // ADR-0025 datagram carrier: how many recent frames' packets the host keeps for
    // resend, and the cap on packets served per resend request.
    static let ownedMediaResendRingFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RESEND_RING_FRAMES",
        defaultValue: 240
    )
    static let ownedMediaMaxResendPackets = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MAX_RESEND_PACKETS",
        defaultValue: 256
    )
    // ADR-0025 motion carrier switch. ON by default now that the carrier and the
    // client video path are device-validated: the HEVC datagram carrier is the
    // primary media path (see ownedMediaMotionMode). Set the env var to 0 to fall
    // back to the reliable retained-tile path only.
    static let ownedMediaVideoMotionEnabled: Bool = enabledFlag(
        environmentKey: "AGENTDESK_OWNED_MEDIA_VIDEO_MOTION_ENABLED",
        defaultValue: true,
        environment: ProcessInfo.processInfo.environment
    )
    // Which motion-carrier mode the encode pump runs in. alwaysVideo (default) =
    // continuous video, no tiles; tiles_motion = video on scroll, tiles at rest.
    static let ownedMediaMotionMode = OwnedMediaMotionMode(
        rawEnvironmentValue: ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_MOTION_MODE"]
    )
    // QUIC DATAGRAM frame size advertised on the graphics group when the motion
    // carrier is on. Packets are sized under this (MediaDatagramFramePacket caps
    // payload at 1050, plus header/MAC, comfortably under a 1300 frame).
    static let ownedMediaMaxDatagramFrameSize = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MAX_DATAGRAM_FRAME_SIZE",
        defaultValue: 1300
    )
    // Video encoder GOP: the HEVC datagram carrier's keyframe cadence. THE keyframe
    // knob (AGENTDESK_OWNED_MEDIA_KEYFRAME_INTERVAL_FRAMES). 120 keeps the keyframe-tax
    // bandwidth low (the dominant rest cost under alwaysVideo); datagram loss recovers
    // via the next periodic keyframe or a client keyframe request. Lower it to bound the
    // worst-case post-loss glitch at the cost of more keyframe bandwidth.
    static let ownedMediaKeyframeIntervalFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_KEYFRAME_INTERVAL_FRAMES",
        defaultValue: 120
    )
    // ADR-0025 motion carrier: the dedicated QUIC datagram listener's port, distinct
    // from graphicsPort (41889) and offerPort (41890). Only bound when the motion
    // carrier flag is on.
    static let ownedMediaDatagramPort = port(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DATAGRAM_PORT",
        defaultValue: 41_891
    )
    // ADR-0025 motion carrier: a frame's HEVC packets are sent in paced bursts so a
    // large frame (170+ packets) does not flood the QUIC datagram send buffer in one
    // tight loop. burstPacketCount packets go back-to-back, then a burstPauseUs gap.
    static let ownedMediaDatagramBurstPacketCount = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DATAGRAM_BURST_PACKET_COUNT",
        defaultValue: 32
    )
    static let ownedMediaDatagramBurstPauseUs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DATAGRAM_BURST_PAUSE_US",
        defaultValue: 1_000
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
    // In-flight BYTE ceiling for graphics backpressure (A2). The frame-count cap
    // above lets two ~120KB fast-scroll frames buffer at once (~240KB), deep enough
    // that a client-requested reset stripe's ack waits seconds behind them on the
    // ~2Mbps link, the freeze cascade. Gating on in-flight bytes too keeps the
    // reliable send buffer shallow so a reset drains fast. The first frame is always
    // admitted, so a single large frame is never permanently stalled. Tune on device.
    static let hybridMaxUnackedBytes = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_MAX_UNACKED_BYTES",
        defaultValue: 131_072
    )
    // Token-bucket send pacer budget (A1). The reliable graphics channel sustains
    // ~2Mbps ~= 256KB/s. The pacer refills at this rate and is debited each frame's
    // wire size, so sustained fast scroll (100KB+ exposed strips) paces to the link
    // instead of running ~4x over budget until the send buffer saturates. This makes
    // cadence track the actual link; the unacked-frame count cannot, because the
    // client drains frames too fast to ever signal real link saturation. Tune on device.
    static let hybridLinkBytesPerSecond = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_LINK_BYTES_PER_SECOND",
        defaultValue: 262_144
    )
    // Burst capacity (and max debt) of the send pacer. A full bucket lets an
    // idle->active transition send immediately; once drained, a big frame repays its
    // overshoot as a longer inter-frame wait. Bounding the debt at this size caps the
    // recovery delay after one oversized frame so it cannot stall for many seconds.
    // ~1 second of budget.
    static let hybridSendPacerBurstBytes = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_SEND_PACER_BURST_BYTES",
        defaultValue: 262_144
    )
    // How long a scroll input keeps the motion signal active (scrolling). It bridges
    // the gap between input bursts within one gesture plus brief post-gesture
    // settling, so a bursty flick reads as one continuous scroll and the frame after
    // it settles to rest. The signal only selects the readable-floor quality for
    // fast-scroll tiles, so a stale-but-active signal cannot corrupt the surface.
    static let hybridScrollActiveWindowMs = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_ACTIVE_WINDOW_MS",
        defaultValue: 600
    )
    // Coverage above which a damage change is gridded as a whole-surface
    // fullframe instead of damage-only tiles. This was 0.15 when an un-scrolled
    // tile was a raw LZFSE bitmap on the reliable channel and a near-full tile
    // (~600KB) froze the pump (R75 confirmed 0.6 froze). That premise is gone:
    // .tiles and .fullFrame now share the rung-1/2/3 cache ladder and progressive
    // chunking (hybridFrameSendBudgetBytes), so a high-coverage tiles set references
    // cached cells (zero payload) and streams genuinely-new cells across several
    // bounded envelopes, the same cost ceiling as fullframe. Raised to 0.6 so a regional
    // 1/4-to-1/2-screen repaint or a scroll-detection miss stays a damage-only
    // grid rather than a whole-surface resend. The exact ceiling is a device-data
    // decision; this is the safe higher default, env-overridable for tuning.
    static let hybridClassifierMaxTileCoverageRatio = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_CLASSIFIER_MAX_TILE_COVERAGE_RATIO",
        defaultValue: 0.6
    )
    // MotionGovernor policy table. These few knobs replace the deleted
    // congestion-EWMA trio and the three fullframe-quality knobs with one
    // cadence-first ladder (see MotionGovernor).
    // Lossy-cell quality at rest (crisp; text still rides lossless LZFSE, so this
    // only covers busy cells) and the readable floor while scrolling (a fast scroll
    // tiles the damage at this floor; slow scrolls and rest stay crisp).
    static let hybridRestJpegQuality = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_REST_JPEG_QUALITY",
        defaultValue: 0.85
    )
    static let hybridScrollExposedReadableQuality = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_EXPOSED_READABLE_QUALITY",
        defaultValue: 0.5
    )
    // Cadence release valve: each held (unacked-capped) frame widens the minimum
    // produce interval by this step, capped at the max. heldCount 0 imposes no
    // throttle. Defaults drop roughly 60fps -> 30fps at one held frame and toward
    // ~10fps under sustained backpressure.
    static let hybridMotionFrameIntervalStepNs = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_MOTION_FRAME_INTERVAL_STEP_NS",
        defaultValue: 33_000_000
    )
    static let hybridMotionFrameIntervalMaxNs = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_MOTION_FRAME_INTERVAL_MAX_NS",
        defaultValue: 120_000_000
    )
    // Resolution scale applied to BUSY (photo) cells only under backpressure; text
    // cells never downscale (downscaling blurs glyphs worse than a quality drop).
    static let hybridBusyResolutionScaleFloor = positiveDouble(
        environmentKey: "AGENTDESK_HYBRID_BUSY_RESOLUTION_SCALE_FLOOR",
        defaultValue: 0.5
    )
    // Hard ceiling on a single JPEG tile's wire size. A whole-screen change at
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
    // C2: hard ceiling on the adaptive reset-ack grace (see resetStripeAckGraceAttempts).
    // A misconfigured tiny link budget would otherwise compute an unbounded wait; this
    // bounds it. A genuinely dead channel still aborts within one round via the
    // per-round connection-alive check regardless of this ceiling.
    static let hybridResetStripeAckCeilingAttempts = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_RESET_STRIPE_ACK_CEILING_ATTEMPTS",
        defaultValue: 30
    )
    // C2: how many hybridResetStripeAckTimeoutMs rounds to wait for a reset stripe's
    // ack before declaring the channel dead. A reset stripe queues behind at most the
    // in-flight byte ceiling (A2 keeps the send buffer shallow) plus its own bytes, so
    // the time to drain to its ack is ~ (ceiling + stripe) / linkBytesPerSecond. Grant
    // grace covering that drain plus a margin, floored at hybridResetStripeAckMaxAttempts
    // (the prior fixed value, so a normal link is unchanged) and ceilinged so the wait
    // is bounded. The device freeze hit a 6.6s drain that the fixed 6-round (6s) grace
    // just missed; scaling with the configured link rate gives a slower link more grace.
    static func resetStripeAckGraceAttempts(stripeBytes: Int) -> Int {
        let backlogBytes = hybridMaxUnackedBytes + max(0, stripeBytes)
        let drainMs = Double(backlogBytes) / Double(max(1, hybridLinkBytesPerSecond)) * 1_000
        let perRoundMs = Double(max(1, hybridResetStripeAckTimeoutMs))
        let neededRounds = Int((drainMs / perRoundMs).rounded(.up)) + 2
        return min(max(neededRounds, hybridResetStripeAckMaxAttempts), hybridResetStripeAckCeilingAttempts)
    }
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
    // existed to prevent. ADR-0022 progressive repaint: the tiler accumulates
    // appended payload bytes across cells; once one envelope's running total crosses
    // this budget, the envelope is closed and the remaining cells continue in the
    // next envelope of the same surface generation (rising frameId). A large repaint
    // therefore streams in as several bounded frames the client paints cell-by-cell
    // into its retained surface, instead of one frame that head-of-line blocks the
    // channel. Text stays lossless LZFSE at native resolution (no per-frame
    // downscale); only content-busy photo cells re-encode to JPEG. Cells that hit
    // rung 1 (omitted) or rung 2 (drawCachedTile) carry no payload and never count
    // toward the budget, so a mostly-cached screen stays a single zero-byte envelope.
    //
    // Calibration: the link is ~2Mbps ~= 250KB/s, so a ~128KB envelope drains in
    // ~0.5s. Smaller envelopes paint more smoothly but add per-frame overhead; this
    // is the per-envelope size, not a per-screen cap. Tune to the link on device via
    // AGENTDESK_HYBRID_FRAME_SEND_BUDGET_BYTES.
    static let hybridFrameSendBudgetBytes: Int = positiveInt(
        environmentKey: "AGENTDESK_HYBRID_FRAME_SEND_BUDGET_BYTES",
        defaultValue: 131_072
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
    static func port(environmentKey: String, defaultValue: UInt16) -> UInt16 {
        guard let raw = ProcessInfo.processInfo.environment[environmentKey],
              let value = UInt16(raw),
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
