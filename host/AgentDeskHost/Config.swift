import Foundation

enum Config {
    enum OwnedMediaCodecChoice: String {
        case hevc
        case h264

        init(rawEnvironmentValue: String?) {
            switch rawEnvironmentValue?.lowercased() {
            case "h264":
                self = .h264
            default:
                self = .hevc
            }
        }

        var wireCodec: OwnedMediaCodec {
            switch self {
            case .hevc: .hevc
            case .h264: .h264
            }
        }
    }

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

    enum OwnedMediaHEVCProfile: String {
        case main
        case main10
        case main42210
        case main444
        case main44410

        init?(rawEnvironmentValue: String?) {
            switch rawEnvironmentValue?.lowercased() {
            case "main":
                self = .main
            case "main10":
                self = .main10
            case "main42210", "42210":
                self = .main42210
            case "main444", "444":
                self = .main444
            case "main44410", "44410":
                self = .main44410
            default:
                return nil
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
    static let ownedMediaCodec = OwnedMediaCodecChoice(
        rawEnvironmentValue: ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_CODEC"]
    )
    static let ownedMediaChroma = OwnedMediaChroma(
        rawEnvironmentValue: ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_CHROMA"]
    )
    static let ownedMediaHEVCProfile: OwnedMediaHEVCProfile? = {
        if let configured = OwnedMediaHEVCProfile(
            rawEnvironmentValue: ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_HEVC_PROFILE"]
        ) {
            return configured
        }
        switch ownedMediaChroma {
        case .yuv444, .bgra:
            return .main444
        case .yuv420:
            return nil
        }
    }()
    static let ownedMediaMaxQP = ownedMediaMaxQP(
        environment: ProcessInfo.processInfo.environment
    )
    static let ownedMediaDatagramBurstPacketCount = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DATAGRAM_BURST_PACKET_COUNT",
        defaultValue: 32
    )
    static let ownedMediaDatagramBurstPauseUs = nonNegativeInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DATAGRAM_BURST_PAUSE_US",
        defaultValue: 1_000
    )
    static let ownedMediaLargeFramePacketThreshold = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_LARGE_FRAME_PACKET_THRESHOLD",
        defaultValue: 64
    )
    static let ownedMediaJumboFramePacketThreshold = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_PACKET_THRESHOLD",
        defaultValue: 128
    )
    static let ownedMediaLargeFrameBurstPacketCount = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_LARGE_FRAME_BURST_PACKET_COUNT",
        defaultValue: 24
    )
    static let ownedMediaLargeFrameBurstPauseUs = nonNegativeInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_LARGE_FRAME_BURST_PAUSE_US",
        defaultValue: 1_500
    )
    static let ownedMediaJumboFrameBurstPacketCount = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_BURST_PACKET_COUNT",
        defaultValue: 16
    )
    static let ownedMediaJumboFrameBurstPauseUs = nonNegativeInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_BURST_PAUSE_US",
        defaultValue: 1_500
    )
    static let ownedMediaQuicMaxDatagramBytes = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_QUIC_MAX_DATAGRAM_BYTES",
        defaultValue: 1_200
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
    static let ownedMediaMotionBudgetEnabled = enabledFlag(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_BUDGET_ENABLED",
        defaultValue: true,
        environment: ProcessInfo.processInfo.environment
    )
    static let ownedMediaMotionBitrateKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_BITRATE_KBPS",
        defaultValue: 5_000
    )
    static let ownedMediaMotionFps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_FPS",
        defaultValue: 15
    )
    static let ownedMediaMotionScaleDown = ownedMediaMotionScaleDown(
        environment: ProcessInfo.processInfo.environment
    )
    static let ownedMediaMotionFrameAgeMs = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_FRAME_AGE_MS",
        defaultValue: 80
    )
    static let ownedMediaMotionBacklogFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_BACKLOG_FRAMES",
        defaultValue: 1
    )
    static let ownedMediaMotionInflightBytes = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_INFLIGHT_BYTES",
        defaultValue: 120_000
    )
    static let ownedMediaRestBudgetHoldMs = nonNegativeInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_REST_BUDGET_HOLD_MS",
        defaultValue: 500
    )
    static let ownedMediaKeyframeIntervalFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_KEYFRAME_INTERVAL_FRAMES",
        defaultValue: 120
    )
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
    static let ownedMediaBackpressureFrameAgeMs = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_FRAME_AGE_MS",
        defaultValue: 80
    )
    static let ownedMediaBackpressureSevereFrameAgeMs = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_SEVERE_FRAME_AGE_MS",
        defaultValue: 500
    )
    static let ownedMediaBackpressureMaxInflightFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_MAX_INFLIGHT_FRAMES",
        defaultValue: 2
    )
    static let ownedMediaBackpressureMaxInflightBytes = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_MAX_INFLIGHT_BYTES",
        defaultValue: 300_000
    )
    static let ownedMediaBackpressureBurstPacketCount = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_BURST_PACKET_COUNT",
        defaultValue: 16
    )
    static let ownedMediaBackpressureBurstPauseUs = nonNegativeInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_BURST_PAUSE_US",
        defaultValue: 2_500
    )
    static let ownedMediaBackpressureEncodeIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_ENCODE_INTERVAL_MS",
        defaultValue: 67
    )
    static let ownedMediaBackpressureSevereEncodeIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_SEVERE_ENCODE_INTERVAL_MS",
        defaultValue: 200
    )
    static let ownedMediaDrainTimeoutMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DRAIN_TIMEOUT_MS",
        defaultValue: 700
    )
    static let ownedMediaKeyframeCooldownMs = nonNegativeInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_KEYFRAME_COOLDOWN_MS",
        defaultValue: 1_000
    )
    static let ownedMediaNormalMaxUnackedFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_NORMAL_MAX_UNACKED_FRAMES",
        defaultValue: 2
    )
    static let ownedMediaBehindMaxUnackedFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BEHIND_MAX_UNACKED_FRAMES",
        defaultValue: 1
    )
    static let ownedMediaStaleUnackedMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_STALE_UNACKED_MS",
        defaultValue: 350
    )
    static let hybridScrollHEVCFps = nonNegativeInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_HEVC_FPS",
        defaultValue: 0
    )
    // Cap on full-frame HEVC fallback frames per second while a scroll is active.
    // Scroll frames the graphics path cannot copyRect otherwise each emit a full
    // HEVC frame at capture rate and flood the client (R77: backlog 327, 10.9s
    // freeze). The copyRect stream carries the translatable motion; these are
    // periodic full-frame corrections, so a low rate suffices. 0 suppresses them.
    static let hybridScrollFallbackHEVCFps = nonNegativeInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_FALLBACK_HEVC_FPS",
        defaultValue: 12
    )
    // How long after the last scroll input the HEVC fallback stays rate-limited.
    // A flick's momentum keeps generating damage after the input hint expires and
    // those frames usually cannot be copyRect'd; without hysteresis they reject to
    // full-frame HEVC and flood (R77b: 435 rejected, only 11 rate-limited). Covers
    // the momentum tail of a flick.
    static let hybridScrollFallbackHysteresisMs = nonNegativeInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_FALLBACK_HYSTERESIS_MS",
        defaultValue: 1500
    )
    static let hybridScrollIdleRefreshMs = nonNegativeInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_IDLE_REFRESH_MS",
        defaultValue: 250
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
    static let hybridScrollOwnershipMs = nonNegativeInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_OWNERSHIP_MS",
        defaultValue: 500
    )
    static let hybridScrollFallbackAfterMs = nonNegativeInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_FALLBACK_AFTER_MS",
        defaultValue: 300
    )
    static let hybridScrollOwnershipMaxMisses = nonNegativeInt(
        environmentKey: "AGENTDESK_HYBRID_SCROLL_OWNERSHIP_MAX_MISSES",
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
    static let graphicsNormalMaxUnackedFrames = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_NORMAL_MAX_UNACKED_FRAMES",
        defaultValue: 2
    )
    static let graphicsBehindMaxUnackedFrames = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_BEHIND_MAX_UNACKED_FRAMES",
        defaultValue: 1
    )
    static let graphicsMaxUnackedBytes = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_MAX_UNACKED_BYTES",
        defaultValue: 180_000
    )
    static let graphicsBehindQueuedFrames = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_BEHIND_QUEUED_FRAMES",
        defaultValue: 1
    )
    static let graphicsSevereQueuedFrames = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_SEVERE_QUEUED_FRAMES",
        defaultValue: 3
    )
    static let graphicsBehindQueueDepthBytes = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_BEHIND_QUEUE_DEPTH_BYTES",
        defaultValue: 120_000
    )
    static let graphicsSevereQueueDepthBytes = positiveInt(
        environmentKey: "AGENTDESK_GRAPHICS_SEVERE_QUEUE_DEPTH_BYTES",
        defaultValue: 360_000
    )
    static let graphicsBehindCompositorMs = positiveDouble(
        environmentKey: "AGENTDESK_GRAPHICS_BEHIND_COMPOSITOR_MS",
        defaultValue: 8
    )
    static let graphicsSevereCompositorMs = positiveDouble(
        environmentKey: "AGENTDESK_GRAPHICS_SEVERE_COMPOSITOR_MS",
        defaultValue: 24
    )
    static func ownedMediaMaxQP(environment: [String: String]) -> Int? {
        guard let raw = environment["AGENTDESK_OWNED_MEDIA_MAX_QP"],
              let value = Int(raw),
              value > 0
        else {
            return nil
        }
        return value
    }
    static func ownedMediaMotionScaleDown(environment: [String: String]) -> Double {
        positiveDouble(
            environment: environment,
            environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN",
            defaultValue: 1.25
        )
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
