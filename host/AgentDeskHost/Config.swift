import Foundation
import AgentDeskWire

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

    // Build tier, derived from the bundle id (not a runtime flag). The dev host
    // (com.example.agentdesk.AgentDeskHost.dev) runs concurrently with the stable host, so
    // every loopback port it binds must differ. The dev block is the stable port
    // + 100 so the two never overlap and the offset is obvious in `lsof`.
    enum Tier {
        case stable
        case dev
    }
    static let tier: Tier = bundleIdentifier.hasSuffix(".dev") ? .dev : .stable
    static func tieredPort(stable: UInt16, dev: UInt16) -> UInt16 {
        tier == .dev ? dev : stable
    }
    // Host listens for the client's session dial here; the bound value is
    // advertised to the client in the pairing offer (PairingPayload.signalingPort),
    // so the client dials this exact port rather than assuming a default.
    static let signalingPort: UInt16 = port(
        environmentKey: "AGENTDESK_SIGNALING_PORT",
        defaultValue: tieredPort(stable: 41_888, dev: 41_988)
    )
    static let sessionQuicALPN = WireProtocol.sessionQuicALPN
    // ADR-0019: dedicated plain-TCP port the Mac dials to push a pairing offer
    // to a chosen tailnet device. Separate from the TLS signaling port so the
    // offer path never touches the IP-literal-cert problem.
    static let offerPort = port(
        environmentKey: "AGENTDESK_OFFER_PORT",
        defaultValue: tieredPort(stable: 41_890, dev: 41_990)
    )
    // ADR-0020: wire protocol version negotiated at the session handshake. Bumped
    // only on a breaking wire change, independent of the marketing version. The
    // peer is rejected if its protocolVersion is below minCompatibleProtocolVersion.
    static let protocolVersion = WireProtocol.version
    static let minCompatibleProtocolVersion = WireProtocol.minCompatibleVersion
    static let nonceTTL: TimeInterval = 90
    static let sessionResumeTTL: TimeInterval = 20
    // ADR-0049: a pre-armed pairing target (a device picked while its app was
    // closed) is polled for readiness this often, and the intent is dropped after
    // this TTL so a phone that never opens does not poll forever.
    static let preArmPollInterval = positiveDouble(
        environmentKey: "AGENTDESK_PREARM_POLL_INTERVAL",
        defaultValue: 5
    )
    static let preArmTTL = positiveDouble(
        environmentKey: "AGENTDESK_PREARM_TTL",
        defaultValue: 30 * 60
    )
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
    // ADR-0033 adaptive media-quality controller knobs. Down fast on loss, up slow
    // on a clean streak; see MediaQualityController.
    static let ownedMediaBitrateFloorKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BITRATE_FLOOR_KBPS",
        defaultValue: 800
    )
    // ADR-0033 survival rung bitrate. This is the last fixed target after the
    // controller has spent bitrate, resolution, and fps.
    static let ownedMediaSurvivalBitrateFloorKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_SURVIVAL_BITRATE_FLOOR_KBPS",
        defaultValue: 300
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
    // Consecutive low-production windows before cadence pressure alone steps down
    // to a capacity rung. Queue pressure or stale recovery can step down sooner.
    static let ownedMediaCadenceDownWindows = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CADENCE_DOWN_WINDOWS",
        defaultValue: 2
    )
    // ADR-0033 latency heuristics for the host-derived frame ACK age. High ACK age
    // alone holds the current rung because a high-latency path can still be healthy;
    // high ACK age plus repaired loss or frame expiry downshifts.
    static let ownedMediaAckHoldP95Ms = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_ACK_HOLD_P95_MS",
        defaultValue: 180
    )
    static let ownedMediaAckDownP95Ms = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_ACK_DOWN_P95_MS",
        defaultValue: 350
    )
    // Smoothness-first ladder thresholds. A cadence gap means the host cannot keep
    // motion fluid at the current target. A freeze gap skips bitrate-only spending.
    static let ownedMediaCadenceGapMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CADENCE_GAP_MS",
        defaultValue: 500
    )
    static let ownedMediaFreezeGapMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_FREEZE_GAP_MS",
        defaultValue: 1_000
    )
    static let ownedMediaFreezeFpsCeiling = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_FREEZE_FPS_CEILING",
        defaultValue: 3
    )
    static let ownedMediaRecoveryMaxGapMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RECOVERY_MAX_GAP_MS",
        defaultValue: 300
    )
    static let ownedMediaRecoveryMinFpsPermille = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RECOVERY_MIN_FPS_PERMILLE",
        defaultValue: 800
    )
    static let ownedMediaTransitionWarmupWindows = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_TRANSITION_WARMUP_WINDOWS",
        defaultValue: 1
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
    // ADR-0033 fixed capacity rungs. Once bitrate has been spent to the normal floor
    // and the link still shows loss/expiry, the controller changes resolution, fps,
    // and bitrate together instead of bolting resolution onto a separate loop.
    static let ownedMediaCapacity1BitrateKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CAPACITY1_BITRATE_KBPS",
        defaultValue: 650
    )
    static let ownedMediaCapacity1Fps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CAPACITY1_FPS",
        defaultValue: 24
    )
    static let ownedMediaCapacity1ResolutionScale = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CAPACITY1_RESOLUTION_SCALE",
        defaultValue: 0.75
    )
    static let ownedMediaCapacity2BitrateKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CAPACITY2_BITRATE_KBPS",
        defaultValue: 400
    )
    static let ownedMediaCapacity2Fps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CAPACITY2_FPS",
        defaultValue: 15
    )
    static let ownedMediaCapacity2ResolutionScale = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CAPACITY2_RESOLUTION_SCALE",
        defaultValue: 0.5
    )
    static let ownedMediaSurvivalResolutionScale = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_SURVIVAL_RESOLUTION_SCALE",
        defaultValue: 0.5
    )
    // ADR-0033 survival cadence target. A lower emergency rung exists for paths
    // that still freeze after survival.
    static let ownedMediaFpsFloor = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_FPS_FLOOR",
        defaultValue: 10
    )
    static let ownedMediaEmergencyBitrateKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_EMERGENCY_BITRATE_KBPS",
        defaultValue: 180
    )
    static let ownedMediaEmergencyFps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_EMERGENCY_FPS",
        defaultValue: 6
    )
    static let ownedMediaEmergencyResolutionScale = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_EMERGENCY_RESOLUTION_SCALE",
        defaultValue: 0.33
    )
    // Tile-path periodic full-surface heal cadence (ScrollDeltaEngine.healIntervalFrames).
    // Named for the heal it actually drives, not a video keyframe. The video GOP is the
    // separate ownedMediaKeyframeIntervalFrames below.
    static let ownedMediaTileHealIntervalFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_TILE_HEAL_INTERVAL_FRAMES",
        defaultValue: 120
    )
    // ADR-0036: crisp observe is damage-gated between full-surface heals. This is how
    // many crisp windows (each >= ownedMediaCrispMinIntervalMs) may run gated before the
    // transport forces a full-surface heal that reconciles trusted crisp tiles against
    // OS damage under-reporting. Default 10 (~1s at the 100ms crisp interval). 0 disables
    // gating (every window is a full heal), the escape hatch if damage is ever mistrusted.
    static let ownedMediaCrispHealIntervalWindows = nonNegativeInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CRISP_HEAL_INTERVAL_WINDOWS",
        defaultValue: 10
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
    // ADR-0030: video datagrams ride the authenticated session QUIC connection.
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
    // ADR-0030: the media lane now shares one QUIC session with input/control, so
    // video admission must keep in-flight media bounded instead of filling the
    // connection behind input.
    //
    // This is the frame-count half of the in-flight window; the byte ceiling below is
    // the real bufferbloat guard. On a high-latency link (acks 400-900ms) the count is
    // the binding limit: with only 2 frames allowed in flight, motion delivers ~2 frames
    // per round-trip (~2.5fps) no matter how much bandwidth is free, so a slow scroll
    // stalls. A larger window fills the bandwidth-delay product so each rung can actually
    // hit its fps target during motion. It does not deepen bufferbloat: small frames
    // transit the RTT in parallel, and the byte ceiling still caps total in-flight bytes,
    // so a heavy scroll binds on bytes long before 6 large frames queue up.
    static let ownedMediaBackpressureMaxInflightFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_MAX_INFLIGHT_FRAMES",
        defaultValue: 6
    )
    static let ownedMediaBackpressureMaxInflightBytes = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_MAX_INFLIGHT_BYTES",
        defaultValue: 300_000
    )
    static let ownedMediaDrainRetryIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DRAIN_RETRY_INTERVAL_MS",
        defaultValue: 250
    )
    static let ownedMediaBackpressureStaleTimeoutMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_STALE_TIMEOUT_MS",
        defaultValue: 1_500
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
    // ADR-0034 crisp-repair (RegionCrispController). A tile must hold the same content
    // for this long before it is promoted to a crisp tile over the reliable graphics
    // lane; shorter sharpens sooner but risks promoting mid-settle.
    // Master on/off for the crisp text layer. Crisp is the per-tile settle-detect +
    // BGRA-render + hash + cache pipeline that overlays sharp text on top of the video
    // floor; the video stream alone is fully functional without it. Default on. Set the
    // env to 0/off to skip processCrisp entirely (no convert, no hash, no crisp lane
    // sends) -- the clean gate for isolating crisp's CPU contribution and for a
    // video-only fallback. This is a coarse gate: when off, processCrisp returns before
    // any work; the video path is untouched.
    static let ownedMediaCrispEnabled: Bool = enabledFlag(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CRISP_ENABLED",
        defaultValue: true,
        environment: ProcessInfo.processInfo.environment
    )
    static let ownedMediaCrispSettleWindowMs: Int = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CRISP_SETTLE_WINDOW_MS",
        defaultValue: 200
    )
    // Crisp slot cache capacity. Must exceed the visible tile count (a full Retina
    // screen at the 64px grid is ~551 tiles) or crisp tiles thrash and get throttled.
    static let ownedMediaCrispCacheSlots: Int = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CRISP_CACHE_SLOTS",
        defaultValue: 640
    )
    // Minimum gap between crisp passes. Crisp hashes the full surface, so running it on
    // every video frame would load the CPU enough to confound the very smoothness we
    // protect. The settle window is time-based, so a coarser crisp cadence (default
    // ~10fps) still detects settle correctly while bounding the rehash cost.
    static let ownedMediaCrispMinIntervalMs: Int = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CRISP_MIN_INTERVAL_MS",
        defaultValue: 100
    )
    // Cap on NEW crisp tile bytes emitted per crisp window. This bounds the size of a
    // single crisp chunk on the reliable graphics lane. The lane shares one QUIC
    // connection with the video datagrams, so a large chunk serializes ahead of them: a
    // 256KB chunk takes ~0.5-1s to clear on a few-Mbps link, spiking video latency to
    // ~1s and reading as steppy motion. A small chunk (~48KB) clears in <150ms and
    // interleaves with video instead of blocking it. A full-surface settle is spread
    // across many windows (and bounded further by the per-second rate cap below).
    // Reverts and cache hits carry no payload, so only fresh cacheTile payload counts.
    static let ownedMediaCrispMaxBytesPerWindow: Int = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CRISP_MAX_BYTES_PER_WINDOW",
        defaultValue: 32_768
    )
    // Sustained crisp byte-rate ceiling, enforced in the transport across crisp windows.
    // Crisp is a settled-content luxury that must never steal the link from motion. The
    // per-window cap bounds one chunk; this bounds the cumulative rate so a big re-cache
    // (e.g. a desktop full of text) trickles out over seconds at a rate that leaves the
    // link free for video, instead of pacing windows straight at the per-window cap. Kept
    // well under the video link estimate (hybridLinkBytesPerSecond, ~256KB/s) so crisp is
    // clearly subordinate to video; crisp only consumes the calm-time headroom that the
    // in-flight-frame yield gate confirms video is not using. Only fresh cacheTile payload
    // bytes count. Tune on device alongside hybridLinkBytesPerSecond.
    static let ownedMediaCrispMaxBytesPerSecond: Int = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CRISP_MAX_BYTES_PER_SECOND",
        defaultValue: 131_072
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
    static let spaceThumbnailCaptureTimeoutMs = positiveInt(
        environmentKey: "AGENTDESK_SPACE_THUMBNAIL_CAPTURE_TIMEOUT_MS",
        defaultValue: 8_000
    )
    // Kill switch for the Space thumbnail capture pipeline (ADR-0006). When off,
    // SpaceThumbnailProvider never captures regardless of client demand: no 3s
    // refresh timer, no space-change observer, no composite. This pipeline shows
    // up in host profiles (vImage/CoreGraphics compositing of every Space's
    // windows) independent of the video stream, so disabling it is the lever for
    // that CPU floor. Default on to preserve the desktop-strip previews; set the
    // env to 0 to drop them and reclaim the CPU.
    static let spaceThumbnailsEnabled: Bool = enabledFlag(
        environmentKey: "AGENTDESK_SPACE_THUMBNAILS_ENABLED",
        defaultValue: true,
        environment: ProcessInfo.processInfo.environment
    )
    // Backstop cadence for the cursor mirror. CursorMonitor gates its expensive image
    // fingerprint (TIFF/PNG encode + hash) on the window-server cursor seed, so a static
    // cursor costs one int read per tick. This heartbeat forces a periodic re-fingerprint
    // even when the seed looks unchanged, so a change is never missed if the private seed
    // symbol is ever unavailable (returns a fixed sentinel) -- same "periodic heal" idea as
    // the crisp controller. With a live seed this rarely fires.
    static let cursorImageHeartbeatMs = positiveInt(
        environmentKey: "AGENTDESK_CURSOR_IMAGE_HEARTBEAT_MS",
        defaultValue: 2_000
    )
    // CursorMonitor poll cadence. The per-tick seed read is cheap, so 20Hz keeps the cursor
    // shape/position responsive without cost. Kept as a knob rather than a magic constant.
    static let cursorPollIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_CURSOR_POLL_INTERVAL_MS",
        defaultValue: 50
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
    // ATC engine sidecar. The binary is compiled by `just build-agent-sidecar`
    // and bundled as a resource in the host app. The port is loopback-only and
    // must not conflict with other services; override via env for debugging.
    // The resource name is the leaf filename of the compiled binary.
    static let agentSidecarPort: UInt16 = port(
        environmentKey: "AGENTDESK_SIDECAR_PORT",
        defaultValue: tieredPort(stable: 7682, dev: 7782)
    )
    static let agentSidecarResourceName = "atc-sidecar"
    static var agentSidecarURL: URL? {
        Bundle.main.url(forResource: agentSidecarResourceName, withExtension: nil)
    }
    static let ptyManagerResourceName = "pty-manager"
    static var ptyManagerURL: URL? {
        Bundle.main.url(forResource: ptyManagerResourceName, withExtension: nil)
    }

    // Identity root. Every per-install anchor (log subsystem, launchd label,
    // dispatch-queue prefix, keychain service, Application Support directory)
    // derives from the running bundle id, so the stable and experimental host
    // variants (com.example.agentdesk.AgentDeskHost / .dev) self-namespace their logs,
    // credentials, launchd registration, and on-disk state without sharing any
    // of it. Mirrors the client (client/AgentDeskClient/Config.swift). The
    // fallback covers the theoretical nil (never nil for a real app bundle).
    static let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.example.agentdesk.AgentDeskHost"
    static let logSubsystem = bundleIdentifier
    static let launchAgentLabel = bundleIdentifier
    static let dispatchQueuePrefix = bundleIdentifier
    // Apple-idiomatic: the Application Support subdirectory is the bundle id, so
    // each variant roots its paired-devices store, TLS identity, unix socket, and
    // signing-key file under a separate tree.
    static let applicationSupportDirectory = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent(bundleIdentifier, isDirectory: true)
    static let pairedDevicesURL = applicationSupportDirectory
        .appendingPathComponent("paired-devices.json", isDirectory: false)
    // ADR-0049: durable pre-armed pairing targets (devices picked while their app
    // was closed), so the intent survives a host restart mid-wait.
    static let preArmedTargetsURL = applicationSupportDirectory
        .appendingPathComponent("pre-armed-targets.json", isDirectory: false)
    static let adSocketURL = applicationSupportDirectory
        .appendingPathComponent("ad.sock", isDirectory: false)
    static let ptyManagerSocketURL = applicationSupportDirectory
        .appendingPathComponent("pty-manager.sock", isDirectory: false)
    static let adTokenURL = applicationSupportDirectory
        .appendingPathComponent("ad-token", isDirectory: false)
    // R16/R17 workspace consolidation. `workspaceStoreURL` is AgentDesk's authoritative,
    // bundle-scoped workspace store. `donorWorkspaceStoreURL` is the retiring
    // agent-workspace-ide store read once at first launch to seed it (the importer treats an
    // absent donor as a clean empty first run, so a wrong or missing path fails safe).
    static let workspaceStoreURL = applicationSupportDirectory
        .appendingPathComponent("workspaces.json", isDirectory: false)
    static let donorWorkspaceStoreURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("agent-workspace-ide/workspace.json", isDirectory: false)
    // R26 authenticated Files lane: the maximum UTF-8 text payload the host will read from or
    // accept for a single file, bounding host memory and wire size. Env-overridable.
    static let workspaceFileMaxBytes = positiveInt(
        environmentKey: "AGENTDESK_WORKSPACE_FILE_MAX_BYTES",
        defaultValue: 4 * 1024 * 1024
    )
    // ADR-0038/0039 DOM mirror (Chrome page mirroring). Baked on by default for every variant:
    // the bridge socket, the .dom QUIC lane, and the client replay surface are live unless
    // explicitly disabled via the env override (AGENTDESK_DOM_MIRROR_ENABLED=0). A prior revert
    // suspected the .dom lane of breaking device pairing, but that was a network-instability
    // confound: the pairing failures were transient tailnet ENETDOWN (-9858) during a flaky /
    // no-WiFi window, and DOM-on pairs reliably on a healthy path (verified on-device). See DECISIONS.
    static let domMirrorEnabled: Bool = enabledFlag(
        environmentKey: "AGENTDESK_DOM_MIRROR_ENABLED",
        defaultValue: true,
        environment: ProcessInfo.processInfo.environment
    )
    // Unix domain socket the sacrificial native-messaging shim (dom-bridge) dials and the
    // host's DomBridgeServer listens on. A Unix socket (not TCP) mirrors adSocketURL: local,
    // filesystem-permissioned, no port to collide across dev/stable stacks. The shim is a
    // normal Chrome-spawned process with the user's permissions, so it can open this path.
    static let domBridgeSocketURL = applicationSupportDirectory
        .appendingPathComponent("ad-dom-bridge.sock", isDirectory: false)
    // Shared-secret file gating the bridge socket, mirroring adTokenURL. The 0o600 Unix socket
    // already limits connections to the user's own processes; the token is defence-in-depth so a
    // rogue same-user process cannot inject DOM into the phone or read input commands. The shim
    // (spawned by Chrome as the same user) reads this file and presents it as its first frame.
    static let domBridgeTokenURL = applicationSupportDirectory
        .appendingPathComponent("ad-dom-bridge-token", isDirectory: false)
    // Durable probe log the DOM-mirror path appends structured lines to (batch counts, checkout
    // markers) so the autonomous harness can assert the bridge loop without a human. Env-overridable.
    static let domMirrorProbeLogURL: URL = {
        let raw = ProcessInfo.processInfo.environment["AGENTDESK_DOM_MIRROR_PROBE_LOG"]
        if let raw, !raw.isEmpty {
            return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath)
        }
        return URL(fileURLWithPath: "/tmp/agentdesk-dom-mirror-host.log")
    }()
    static let devLastPairURLPath = applicationSupportDirectory
        .appendingPathComponent(".last-pair-url", isDirectory: false)
    static let devDiagnosticsRequestPath = applicationSupportDirectory
        .appendingPathComponent(".client-diagnostics-request.json", isDirectory: false)
    static let devDiagnosticsResultPath = applicationSupportDirectory
        .appendingPathComponent(".client-diagnostics-result.json", isDirectory: false)
    static let diagnosticsRequestTimeoutSeconds: TimeInterval = 20
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
    static let keychainService = bundleIdentifier
    static let hostSigningKeyAccount = "host-signing-key"
    static let keychainAccessGroup: String? = nil
    // True when the host was launched by the dev iteration flow (`just host-run`),
    // which sets AGENTDESK_DEV_ITERATION_RUN=1. Such a run is a transient,
    // env-carrying launch, not a production login install, so it must not register
    // a login LaunchAgent. Key storage does not branch on this flag.
    static let devIterationRun: Bool = enabledFlag(
        environmentKey: "AGENTDESK_DEV_ITERATION_RUN",
        defaultValue: false,
        environment: ProcessInfo.processInfo.environment
    )
    // Dev-automation flag: bypass the pairing-approval modal so headless recipes
    // (pair-sim, pair-iphone, motion-verify) pair unattended. Gated on a dev
    // iteration run so a stray AGENTDESK_AUTO_APPROVE in a
    // production launch's environment can never silently auto-approve pairings; the
    // human device pick/approve stays the authorization gate (ADR-0019).
    static let autoApprovePairing: Bool = autoApprovePairingEnabled(
        environment: ProcessInfo.processInfo.environment
    )

    static func autoApprovePairingEnabled(environment: [String: String]) -> Bool {
        enabledFlag(
            environmentKey: "AGENTDESK_DEV_ITERATION_RUN",
            defaultValue: false,
            environment: environment
        ) && enabledFlag(
            environmentKey: "AGENTDESK_AUTO_APPROVE",
            defaultValue: false,
            environment: environment
        )
    }
}
