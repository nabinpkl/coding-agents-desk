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
    // ADR-0101: the continuous target's heartbeat floor. Not 0, because a target of nothing
    // stops all frames, which stops all acks, which starves the delivery estimator and the
    // round-trip tracker -- and a controller that cannot measure cannot climb back. 60kbps is
    // roughly one mean-cost delta frame (7.7KB measured) per second: enough traffic to keep
    // the measurement loop alive, low enough to let a bloated queue actually drain. Also the
    // send pacer's floor, for the same reversibility reason (LinkSendPacer).
    static let ownedMediaFloorKbps = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_FLOOR_KBPS",
        defaultValue: 60
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
    // Smoothing for the live delta-frame wire-cost EWMA (QuicSessionHostMediaState). 0.1 makes
    // the last ~10 delta frames dominate: enough history to ride out one outlier frame, recent
    // enough to track a content change (idle text vs. video playback) within seconds.
    static let ownedMediaFrameBytesEwmaAlpha = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_FRAME_BYTES_EWMA_ALPHA",
        defaultValue: 0.1
    )
    // R231b. How many CONSECUTIVE windows of stale pressure it takes to act on it, mirroring
    // `ownedMediaCadenceDownWindows`. The stale signal is `staleRecoveryCount > 0`: a single
    // abandoned frame, with no magnitude, answered by a jump to a fixed rung. That made the
    // ladder a probe-to-failure oscillator -- climb bitrate geometrically, trip over one
    // frame, collapse, climb again.
    //
    // 2 is set against measurement. Over a 25 minute run stale pressure fired in 59 of 2,664
    // windows, in 51 bursts of which 47 (92%) lasted exactly ONE window. Requiring two
    // consecutive windows would have fired 4 times instead of 51.
    // Magnitude tests were all weaker -- >=2 stale frames still leaves 42% of firings, >=3
    // leaves 29%, a 250-permille rate leaves 39% -- because the median firing window produced
    // only 7 frames and 58% of firings were a single stale frame, so a rate mostly measures how
    // much the screen happened to be changing rather than how bad the link was.
    static let ownedMediaStaleDownWindows = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_STALE_DOWN_WINDOWS",
        defaultValue: 2
    )
    // ADR-0101: what to assume a delta frame costs before the live EWMA has a sample. Sized
    // over the measured mean delta (7.7KB) so an unmeasured session opens with a conservative
    // cadence rather than an optimistic one; the first real frames replace it within a second.
    static let ownedMediaSeedFrameBytes = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_SEED_FRAME_BYTES",
        defaultValue: 10_000
    )
    // ADR-0101: the budget a frame gets over its measured EWMA cost when the cadence is
    // derived (fps = bitrate / (ewma * headroom)). The cb74f8bf floor lesson, generalized: a
    // cadence must fit the frames ABOVE the mean too, or the ones the mean hides queue. 1.3
    // puts the p50 delta (4.8KB) well inside a budget derived from the mean.
    static let ownedMediaFrameBytesHeadroom = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_FRAME_BYTES_HEADROOM",
        defaultValue: 1.3
    )
    // ADR-0101: the fraction of the MEASURED delivery rate a confirmed descent lands at.
    // Below 1.0 on purpose: landing exactly at capacity keeps the queue exactly full, and the
    // point of descending is to drain it. Measured before this existed: sentKbps p90 359
    // against a link delivering 186 -- the controller had no way to land where the link was.
    static let ownedMediaDeliverySnapRatio = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DELIVERY_SNAP_RATIO",
        defaultValue: 0.85
    )
    // Tile-path periodic full-surface heal cadence (ScrollDeltaEngine.healIntervalFrames).
    // Named for the heal it actually drives, not a video keyframe. There is no longer a video
    // GOP interval to confuse it with: ADR-0100 removed periodic keyframe placement entirely.
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
    // ADR-0087: floor between two stall-recovery keyframes. The flush half of recovery is
    // free and runs every stalled window; this spaces out only the keyframe, so a link
    // that is genuinely dead cannot be driven into a keyframe storm by its own stall
    // signal. Same budget arithmetic as the ceiling above; 5s bounds recovery keyframes to
    // 12/min worst case, against the 6-12s freezes it exists to cut short.
    static let ownedMediaStallRecoveryMinIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_STALL_RECOVERY_MIN_INTERVAL_MS",
        defaultValue: 5_000
    )
    // ADR-0088: how long an ack round-trip sample stays eligible to be the path's minimum.
    // This sets what "the floor" means, and both failure modes are real. Too short and the
    // floor follows the queue up, so a path that is filling reports no inflation at all --
    // the exact blindness this replaces. Too long and a genuine move to a slower link is
    // reported as permanent inflation forever. 30s comfortably outlives the 6-12s freezes
    // being diagnosed (so the pre-freeze floor is still in window to compare against) while
    // still letting a real path change settle within half a minute.
    static let ownedMediaRoundTripMinimumWindowMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_ROUND_TRIP_MINIMUM_WINDOW_MS",
        defaultValue: 30_000
    )
    // Which percentile of the round-trip window stands in for the path's floor, as the divisor
    // for the inflation ratio that `isQueueBloated` reads.
    //
    // Not 0, because the minimum is one sample and therefore the one most distorted by luck.
    // Measured over 3466 samples on a healthy Wi-Fi session: `rttMinMs` sat at 6-8ms against a
    // smoothed 25ms, so the median window reported an inflation of 2.7 and 57% of windows
    // crossed the 2.5 bloat threshold with zero loss and no queue. Because that verdict resets a
    // 30-second clean-time requirement, the resolution ladder could not climb at all and the
    // picture stayed at the emergency floor for twenty minutes.
    //
    // 10 rather than a wider quartile, because this percentile is a DELAY as well as a filter.
    // The floor only stops tracking a real queue once that fraction of the window is queued, so
    // at the 30s window a p10 floor concedes about 3 seconds of detection latency where p25
    // would concede 7.5 -- and this detector exists to catch multi-second freezes. 10% still
    // discards a lone fluke comfortably: the ack stream runs near 2Hz, so one unlucky sample is
    // under 2% of a full window.
    //
    // The freeze this was built for measured 5.0, far above threshold on any of these settings.
    // Set to 0 to reproduce the old minimum-based behaviour exactly.
    static let ownedMediaRoundTripFloorPercentile = nonNegativeDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_ROUND_TRIP_FLOOR_PERCENTILE",
        defaultValue: 10
    )
    // ADR-0098: how long delivered bytes accumulate before becoming one goodput sample.
    //
    // The tension is with the ack cadence, not with the quality window. Too short and a single
    // coalesced ack becomes an entire slice, reporting a spike the link never sustained; too
    // long and a stall is averaged together with the healthy stretch before it and disappears.
    // 250ms is several acks at the ~2Hz-plus rate the ack loop produces, and four samples inside
    // every one-second quality window.
    static let ownedMediaDeliverySliceMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DELIVERY_SLICE_MS",
        defaultValue: 250
    )
    // ADR-0098: how long a goodput sample stays eligible to be the window maximum.
    //
    // This is how fast the estimate is allowed to follow a link DOWN, since a max filter only
    // falls by expiry. Short enough that the two-second freezes being diagnosed are not papered
    // over by a capacity measured before them; long enough to outlive an ordinary quiet stretch,
    // which would otherwise expire a perfectly good measurement and make the pacer re-probe from
    // nothing. 5s is five quality windows.
    static let ownedMediaDeliveryWindowMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DELIVERY_WINDOW_MS",
        defaultValue: 5_000
    )
    // ADR-0098: the fraction of the rung's budget the link must be delivering to be considered
    // able to carry it. Below this for `ownedMediaDeliveryShortfallWindows` in a row, the ladder
    // descends on measured capacity rather than on a proxy for it.
    //
    // Not 1.0, and not close to it. The measured rate is bounded above by what was offered even
    // inside a backlogged slice (the encoder undershoots its own average constantly), so a
    // healthy link routinely reads a little under its rung. 0.7 is comfortably below that noise
    // and comfortably above the 4-to-1 shortfall the freeze produced.
    static let ownedMediaDeliveryShortfallRatio = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DELIVERY_SHORTFALL_RATIO",
        defaultValue: 0.7
    )
    // ADR-0098: consecutive windows of measured shortfall before descending. Two, matching the
    // stale and cadence streaks: one window is a burst, two is a link.
    static let ownedMediaDeliveryShortfallWindows = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DELIVERY_SHORTFALL_WINDOWS",
        defaultValue: 2
    )
    // ADR-0098: how many times the smoothed round-trip may exceed the path's own floor before the
    // ladder treats the queue in front of us as the problem.
    //
    // The second half of what ADR-0088 built and never spent. It catches the failure goodput
    // cannot: a path that DELIVERS everything, at its full rate, several seconds late. Bytes are
    // moving, nothing expires, nothing goes stale -- and the picture on the phone is seconds
    // behind the Mac.
    //
    // 2.5 sits between the two measured populations rather than at a round number: an ordinary
    // window on this path ran near 1.0-1.5, and the freeze read 5.0.
    // ADR-0100: the encode resolution, for every rung, for the life of the session.
    //
    // This replaced four per-rung scales (0.75 / 0.5 / 0.5 / 0.33). Descending through them is
    // what made resolution expensive: VideoToolbox fixes width and height at
    // VTCompressionSessionCreate, so a scale change recreates the session and discards every
    // acknowledged LTR reference -- and until a new one completes the round trip, measured at
    // 9-16 seconds, every refresh falls back to a full IDR of ~44KB. On a 208kbps link that is
    // 1.7-2.2 seconds of wire each, which is the freeze it was supposed to prevent.
    //
    // 0.5 rather than the old emergency 0.33: with the axis fixed, the value has to be legible on
    // a fast link as well as affordable on a slow one, and bitrate and fps do the adapting inside
    // it at no cost. Measured, pinning alone took >=1s freezes from 13.6% to 5.3%.
    static let ownedMediaResolutionScale = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RESOLUTION_SCALE",
        defaultValue: 0.5
    )
    // The absolute half of the queue-bloat test: how far behind the picture has to actually be
    // before an inflated ratio is allowed to mean anything. Both must hold -- see
    // `MediaQualityObservationDelivery.isQueueBloated`.
    //
    // 250ms is chosen against measurement, not intuition. Modelled over 472 windows from one
    // session spanning both interfaces, requiring the ratio AND this floor takes the Wi-Fi path
    // from firing in 75% of windows to 0%, and cellular from 17% to 8% -- keeping exactly the
    // windows where that path was genuinely slow. The freeze ADR-0088 was built for was
    // "several seconds late", so it clears this by an order of magnitude.
    //
    // State the cost honestly: on a fast link this makes the queue detector effectively silent,
    // because such a link is never a quarter-second behind. That is the intent -- a 47ms picture
    // is not queued -- but it does mean a genuine queue on a fast path has to be caught by the
    // other signals (stale pressure, delivery shortfall, expiries) rather than by this one.
    // Set to 0 to restore the ratio-only behaviour.
    static let ownedMediaRoundTripBloatMinimumSmoothedMs = nonNegativeDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_ROUND_TRIP_BLOAT_MIN_SMOOTHED_MS",
        defaultValue: 250
    )
    static let ownedMediaRoundTripInflationDownRatio = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_ROUND_TRIP_INFLATION_DOWN_RATIO",
        defaultValue: 2.5
    )
    // ADR-0098: headroom over the measured delivery rate that the send pacer refills at.
    //
    // A pacer that refills at exactly the measured rate can never discover the link got faster,
    // because the max filter can only see bytes we chose to send. The overshoot is the probe.
    // 1.25 recovers a doubling in about three seconds of continuous sending, and is small enough
    // that the queue it builds while probing drains inside one quality window.
    static let ownedMediaDeliveryPacerHeadroom = positiveDouble(
        environmentKey: "AGENTDESK_OWNED_MEDIA_DELIVERY_PACER_HEADROOM",
        defaultValue: 1.25
    )
    // ADR-0088: the host's belief about how often the client reports, used ONLY as the
    // threshold for reading a client report ("no datagrams for at least one report interval"
    // is a stall; a shorter quiet stretch inside one window is not).
    //
    // This mirrors the client's own `ownedMediaLinkHealthIntervalMs`, which the host cannot
    // read: it is a separate app with a separate config, and the value is not negotiated at
    // the handshake. Keeping it as an explicit host-side threshold is deliberate -- the
    // alternative is deriving it from the arrival cadence, which is exactly the thing that
    // breaks during the freeze we are trying to detect. If the client's cadence ever changes,
    // this must change with it or a stall goes unrecognised.
    static let ownedMediaClientReportIntervalMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_CLIENT_REPORT_INTERVAL_MS",
        defaultValue: 500
    )
    // ADR-0087: how long the host waits for a client link-health report before evaluating
    // a window on its own clock. Client reports arrived every ~500ms on device, so 1s is
    // one missed report. Without this the quality window is driven ONLY by inbound client
    // messages, so a client that stops reporting also stops the evaluation that would
    // notice it stopped: during a measured 12.79s freeze not one window ran.
    static let ownedMediaLinkHealthTickMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_LINK_HEALTH_TICK_MS",
        defaultValue: 1_000
    )
    // Loss-immune reference chains: every delta is encoded as an LTR refresh against an
    // acknowledged reference, so any frame the client receives is decodable regardless of what
    // was wholesale-lost before it. Trades larger deltas (prediction from an RTT-older frame)
    // for the near-elimination of resync recovery -- measured before this: 11.5s frozen
    // episodes while few-KB resync answers died in the same congestion that made them
    // necessary, resolved only by 100KB escalated IDRs. Disable to A/B the delta-size cost.
    static let ownedMediaReferenceAckedOnlyEnabled: Bool = enabledFlag(
        environmentKey: "AGENTDESK_OWNED_MEDIA_REFERENCE_ACKED_ONLY",
        defaultValue: true,
        environment: ProcessInfo.processInfo.environment
    )
    // How long a datagram receive loop keeps retrying a throwing `receive()` before it gives up.
    //
    // Both loops used to end on the first error, which made every transient fault permanent.
    // 30s is chosen against the two numbers that bound the problem: the longest measured LTE
    // stall was ~6s, and the client declares the host silent at 6.5s and re-dials. Anything past
    // that is already being handled by someone else, so the budget only has to be comfortably
    // longer than both -- long enough that this loop is never the reason a recoverable session
    // dies, short enough that a genuinely dead connection is still reported rather than retried
    // forever.
    static let ownedMediaReceiveRetryBudgetMs = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_RECEIVE_RETRY_BUDGET_MS",
        defaultValue: 30_000
    )
    // ADR-0030: video datagrams ride the authenticated session QUIC connection.
    //
    // ADR-0098: how many bytes may leave back-to-back before `LinkSendPacer` starts pacing to
    // the rung's budget. This is the anti-burst dial, and it is the one that decides whether a
    // keyframe arrives as a lump or as a stream. The measured failure: 92 datagrams of a 96KB
    // keyframe left in ~2ms under the fixed 32-packet/1ms grouping this replaces, filling a
    // cellular queue that then took two seconds to drain.
    //
    // 16KB is ~15 packets at the 1050-byte payload size, well under the 170-packet flood the
    // old grouping existed to prevent, and small enough that a keyframe is spread rather than
    // dumped. It must stay above `MediaDatagramFramePacket.maxPayloadBytes` or every single
    // packet would wait a full bucket.
    static let ownedMediaSendPacerBurstBytes = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_SEND_PACER_BURST_BYTES",
        defaultValue: 16_384
    )
    // ADR-0030: the media lane now shares one QUIC session with input/control, so
    // video admission must keep in-flight media bounded instead of filling the
    // connection behind input.
    //
    // ADR-0073: these limits bound ACK accounting, not production. When either
    // limit binds, owned media abandons only enough oldest entries to admit the
    // latest frame. The byte limit therefore bounds tracked obsolete data without
    // turning mobile-data latency into a video stall.
    static let ownedMediaBackpressureMaxInflightFrames = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_MAX_INFLIGHT_FRAMES",
        defaultValue: 6
    )
    static let ownedMediaBackpressureMaxInflightBytes = positiveInt(
        environmentKey: "AGENTDESK_OWNED_MEDIA_BACKPRESSURE_MAX_INFLIGHT_BYTES",
        defaultValue: 300_000
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
        positiveInt(
            environment: ProcessInfo.processInfo.environment,
            environmentKey: environmentKey,
            defaultValue: defaultValue
        )
    }
    static func positiveInt(
        environment: [String: String],
        environmentKey: String,
        defaultValue: Int
    ) -> Int {
        guard let raw = environment[environmentKey],
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
    /// Zero-allowing counterpart to `positiveDouble`, for knobs where 0 is a meaningful
    /// setting rather than an unset one -- a percentile, say, where 0 selects the minimum.
    static func nonNegativeDouble(environmentKey: String, defaultValue: Double) -> Double {
        guard let raw = ProcessInfo.processInfo.environment[environmentKey],
              let value = Double(raw),
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
    // Agent feed transcript sidecar. The binary is compiled in-repository and
    // bundled as a host resource. It is reachable only over loopback.
    static let agentFeedSidecarPort: UInt16 = port(
        environmentKey: "AGENTDESK_AGENT_FEED_PORT",
        defaultValue: tieredPort(stable: 7682, dev: 7782)
    )
    // Claude Desktop composer sync. Claude Desktop runs each coding session as a child
    // Claude Code CLI whose argv carries `--resume=<sessionId>`, the same id that names
    // the session's transcript file. Walking that child's parent chain to the Claude.app
    // main binary identifies the window that owns the session; a chain that stops at a
    // shell or tmux is a terminal session with no window to write into. Both values are
    // env-overridable so a non-default install location or a future CLI marker does not
    // need a rebuild.
    static let claudeDesktopMainPath = ProcessInfo.processInfo.environment["AGENTDESK_CLAUDE_MAIN_PATH"]
        ?? "/Applications/Claude.app/Contents/MacOS/Claude"
    // Matched in BOTH argv spellings, because both are live on a normal machine and they mean
    // different things here. Claude Desktop's embedded CLI passes `--resume=<id>`, while a terminal
    // session -- including the ones this host launches itself in `AgentResumeLaunch` -- passes
    // `--resume <id>`. Scanning only the first form would report an open terminal session as "not
    // running" rather than "terminal only", which is the wrong answer on screen and hides the fact
    // that the session is open at all.
    static let claudeResumeFlag = ProcessInfo.processInfo.environment["AGENTDESK_CLAUDE_RESUME_MARK"]
        ?? "--resume"
    // Claude Code writes one `~/.claude/sessions/<pid>.json` per running CLI, keyed by the CLI's real
    // pid. Only a Desktop-spawned coding session carries this `entrypoint` value; a terminal session
    // reads `cli`. The runtime resolver matches it for brand-new sessions whose id never appears in
    // argv. Env-overridable because it is another application's private field and can change without
    // notice.
    static let claudeDesktopRegistryEntrypoint =
        ProcessInfo.processInfo.environment["AGENTDESK_CLAUDE_REGISTRY_ENTRYPOINT"]
        ?? "claude-desktop"
    // How often a watched session is re-resolved against the process table. A `ps` scan plus
    // a chain walk is cheap, but the thing it observes changes only when a human opens or
    // closes a Claude window, so a slower cadence than the panel's other streams is right.
    static let claudeWindowResolveInterval: TimeInterval = 3
    // The `AXDescription` Claude Desktop gives its prompt composer. Matched together with the
    // `AXTextArea` role, never on role alone: a Claude window holds other editable regions, and typing
    // a prompt into one of them is worse than reporting the composer missing. Env-overridable because
    // this is another application's private UI string and can change without notice.
    static let claudeComposerDescription = ProcessInfo.processInfo.environment["AGENTDESK_CLAUDE_COMPOSER_DESC"]
        ?? "Prompt"
    // The `AXDescription` Claude Desktop gives the AskUserQuestion panel's "Other" input. Part of the
    // panel anchor triple (a Submit-prefixed button plus a Skip button plus this input inside one
    // group), so an AskUserQuestion panel is never matched by title alone. Env-overridable because it
    // is another application's private UI string.
    static let claudeQuestionOtherDescription =
        ProcessInfo.processInfo.environment["AGENTDESK_CLAUDE_QUESTION_OTHER_DESC"]
        ?? "Other option"
    // Codex Desktop composer sync. Codex Desktop runs inside ChatGPT.app (bundle com.openai.codex) and
    // exposes one Chromium window per chat thread. Unlike Claude, no child argv carries the thread id:
    // the deterministic mapping is the app's OWN state (`~/.codex/state_5.sqlite` `threads` table and
    // `~/.codex/session_index.jsonl`) joined to each window's accessibility tree -- the header bar
    // (thread title button plus `Project: <name>` popup) in the threads-sidebar layout, or the first
    // row of the window's Recents list (the pinned current thread) in the projects/Recents layout.
    // The main binary path resolves the owning pid; both files are read-only for the host. All values
    // env-overridable because they are another application's private layout and can change without
    // notice.
    static let codexMainPath = ProcessInfo.processInfo.environment["AGENTDESK_CODEX_MAIN_PATH"]
        ?? "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
    // The `AXDescription` Codex Desktop gives its prompt composer. Matched together with the
    // `AXTextArea` role, never on role alone. Env-overridable because it is another application's
    // private UI string and can change without notice.
    static let codexComposerDescription = ProcessInfo.processInfo.environment["AGENTDESK_CODEX_COMPOSER_DESC"]
        ?? "Do anything"
    // The app's own thread registry. `threads` rows keyed by thread id carry `cwd`, `title`,
    // `first_user_message`, and `updated_at`; the header title a window shows is the `thread_name`
    // carried by `session_index.jsonl`, which matches the AX header text exactly.
    static let codexStateSqlite = ProcessInfo.processInfo.environment["AGENTDESK_CODEX_STATE_SQLITE"]
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/state_5.sqlite").path
    static let codexSessionIndex = ProcessInfo.processInfo.environment["AGENTDESK_CODEX_SESSION_INDEX"]
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/session_index.jsonl").path
    // How often a watched codex session is re-resolved against the app's state files and window headers.
    // The state files change only when a human opens, renames, or types in a thread, so a cadence like
    // the Claude window poll is right.
    static let codexWindowResolveInterval: TimeInterval = 3
    // Timeouts for the codex composer path. The materialize budget is how long a window brought to this
    // Desktop is given to build its tree; the verify and submit budgets match the Claude ones because
    // the codex composer is also a Chromium web contents with an async value commit.
    static let codexComposerMaterializeTimeout: TimeInterval = 20
    static let codexComposerMaterializePollInterval: TimeInterval = 0.2
    static let codexComposerVerifySettleTimeout: TimeInterval = 2
    static let codexComposerVerifySettlePollInterval: TimeInterval = 0.1
    static let codexComposerSubmitSettleTimeout: TimeInterval = 2
    static let codexComposerSubmitSettlePollInterval: TimeInterval = 0.1
    // How long a fresh scan waits for Codex Desktop to materialize its accessibility tree. Unlike
    // Claude there is no `AXManualAccessibility` latch to set (the attribute is unsupported on this
    // app), but the tree is built lazily when no assistive-technology client is attached: a probe
    // measured a collapsed tree materializing into the full web contents within two seconds of an AX
    // client attaching. The host is a long-lived client, so the wait costs once per materialization.
    static let codexTreeMaterializeTimeout: TimeInterval = 3
    static let codexTreeMaterializePollInterval: TimeInterval = 0.25
    // How long a window brought to this Desktop is given to build its accessibility tree, and how
    // often it is checked. Chromium builds a window's tree only while it is on the current Space, so
    // the composer genuinely does not exist for the first moments after a move-in. The ceiling bounds
    // a renderer that never answers; the normal cost is one poll. Twenty seconds rather than ten
    // because a busy renderer measured fourteen seconds to build its tree after a move-in in the live
    // probe, and a window moved back without being filled is a visible wasted round trip.
    static let claudeComposerMaterializeTimeout: TimeInterval = 20
    static let claudeComposerMaterializePollInterval: TimeInterval = 0.2
    // A composer scan that finds the window but no prompt field usually means the window's web contents
    // never built its accessibility tree: a wedged contents reads as "composer missing" while the field
    // is plainly on screen. The deterministic recovery is to terminate Claude's renderer children --
    // Chromium respawns the web contents fresh, which materializes the tree. The revive only fires once
    // the composer has been CONTINUOUSLY missing for `claudeRendererReviveMinMissing`, so a tree that
    // flaps on a sub-minute cycle is never killed; after a revive, `claudeRendererReviveCooldown` gates
    // the next one per Claude process, because the coordinator re-resolves every few seconds and without
    // the gate a tree that never rebuilds would be killed on every poll.
    static let claudeRendererReviveMinMissing: TimeInterval = 8
    static let claudeRendererReviveCooldown: TimeInterval = 60
    // How long after an actual revive the already-visible path waits for the respawned tree before
    // reporting missing. The coordinator's own 3s poll retries after that; the moved-window path waits
    // longer, through its own materialize budget.
    static let claudeRendererReviveWait: TimeInterval = 3
    // How long a write's read-back is given to converge. The value commits asynchronously in Chromium,
    // and a web contents mid-rebuild can answer the first read with the old value or the placeholder; a
    // landed write must not fail reconciliation on that stale first read.
    static let claudeComposerVerifySettleTimeout: TimeInterval = 2
    static let claudeComposerVerifySettlePollInterval: TimeInterval = 0.1
    // How long a submit waits for Chromium to clear the composer after Return is pressed. Chromium runs
    // that submit on its own main thread, which a busy session can occupy; the ceiling bounds it, and a
    // composer that has not cleared by then is reported holding whatever text it still has.
    static let claudeComposerSubmitSettleTimeout: TimeInterval = 2
    static let claudeComposerSubmitSettlePollInterval: TimeInterval = 0.1
    // Confirmation that a Desktop move actually took. yabai's move is already visible to SkyLight by
    // the time the command returns, so this is a guard against a stale read, not a settle window.
    static let claudeWindowMoveVerifyAttempts = 4
    static let claudeWindowMoveVerifyInterval: TimeInterval = 0.05
    static let agentFeedSidecarResourceName = "agent-feed-sidecar"
    static var agentFeedSidecarURL: URL? {
        Bundle.main.url(forResource: agentFeedSidecarResourceName, withExtension: nil)
    }
    /// A control token to use instead of minting one, or nil for the normal per-spawn mint.
    ///
    /// The mint is the default because a token nobody else can name is the strongest form of the
    /// capability: the host holds it in memory, the sidecar deletes it from its own environment,
    /// and model-authored bash has nothing to read. Adopting one costs exactly that property, so
    /// it is set only by a dev launch that has a second consumer to serve.
    ///
    /// That consumer is the panel's Vite dev server. A browser tab loading the panel from it has no
    /// relay to attach the sidecar's bearer header, so the server's own /api proxy attaches it --
    /// which requires the server and the sidecar to share a token, and the server starts first
    /// (ADR-0096). Nothing changes for the Mac webview or the phone, which reach the sidecar
    /// through the relay and never hold the token themselves.
    static var agentFeedSidecarControlTokenOverride: String? {
        guard let raw = ProcessInfo.processInfo.environment[agentFeedControlTokenVariable] else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    /// One spelling of the sidecar capability's variable, for the reader above and the stripper
    /// below. The sidecar reads the same name and the Justfile writes it.
    static let agentFeedControlTokenVariable = "AGENT_FEED_CONTROL_TOKEN"
    /// The host's environment with the sidecar capability removed, for children that are not the
    /// agent-feed sidecar.
    ///
    /// Load-bearing whenever a dev launch supplied the token, because then it is in the HOST's own
    /// environment and `Process` hands that to children by default. The child that matters is the
    /// PTY runtime: its descendants are terminal shells, and an agent's bash tool runs inside one.
    /// The sidecar deletes this variable from its own environment for exactly that reason -- so the
    /// agents it spawns cannot read the capability -- and inheriting it down the PTY tree would
    /// reopen the same door from the other side.
    static var childProcessEnvironment: [String: String] {
        childProcessEnvironment(from: ProcessInfo.processInfo.environment)
    }
    /// Takes the environment rather than reading it, so the stripping can be tested against an
    /// environment that actually has the token in it. Reading the real one would let a test pass
    /// on a machine where the variable was never set, which is every machine that is not mid-dev-run.
    static func childProcessEnvironment(from environment: [String: String]) -> [String: String] {
        var sanitized = environment
        sanitized.removeValue(forKey: agentFeedControlTokenVariable)
        return sanitized
    }
    // How long a feed request waits for a sidecar that is still coming up before
    // reporting it as down. The host starts the sidecar alongside the windows that
    // read it, so a consumer arriving first is ordinary, not an error: a cold
    // start measured 1.3s, and the supervisor allows itself 5s to answer plus a
    // first restart at 1s. Ten seconds covers a launch and one restart; past that
    // the sidecar really is not coming, and a visible error the caller can retry
    // beats a hung window.
    static let agentFeedSidecarReadyWaitSeconds: TimeInterval = 10
    // How long a voice request waits for a sidecar still coming up. Sized to the
    // voice supervisor's own 20s readiness budget, so the wait covers exactly one
    // full startup attempt: the observed cold start is 1.3s, and beyond one
    // attempt an interactive caller is better served by an error it can retry than
    // by more silence.
    static let voiceSidecarReadyWaitSeconds: TimeInterval = 20
    // Voice server sidecar (`voice-server` in the gesture-agent project). Runs
    // on loopback like the agent feed sidecar; the phone reaches voice only through the
    // host-mounted webview, never this port.
    static let voiceSidecarPort: UInt16 = port(
        environmentKey: "AGENTDESK_VOICE_SIDECAR_PORT",
        defaultValue: tieredPort(stable: 7692, dev: 7792)
    )
    // Opt-in Python import-time trace for diagnosing cold voice starts. The
    // sidecar keeps structured timing events on stdout while raw dependency
    // stderr goes to this file, avoiding unified-log noise.
    static var voiceImportTimeTraceURL: URL? {
        guard
            let rawPath = ProcessInfo.processInfo.environment[
                "AGENTDESK_VOICE_IMPORTTIME_TRACE_PATH"
            ]?.trimmingCharacters(in: .whitespacesAndNewlines),
            !rawPath.isEmpty
        else {
            return nil
        }
        return URL(
            fileURLWithPath: NSString(string: rawPath).expandingTildeInPath
        )
    }
    // The command that launches the voice server. Env-driven until the
    // Application-Support venv provisioning lands (Phase 3d): a developer sets
    // AGENTDESK_VOICE_UV_PATH (the `uv` binary) and AGENTDESK_VOICE_PROJECT_DIR
    // (the gesture-agent checkout). Returns nil when either is unset, so the
    // host leaves the voice sidecar unstarted rather than spawning a broken
    // child — the absent-config-is-a-no-op contract the agent sidecar also uses.
    static var voiceSidecarLaunch: VoiceSidecarLaunch? {
        let env = ProcessInfo.processInfo.environment
        guard
            let uvPath = env["AGENTDESK_VOICE_UV_PATH"], !uvPath.isEmpty,
            let projectDir = env["AGENTDESK_VOICE_PROJECT_DIR"], !projectDir.isEmpty
        else {
            return nil
        }
        let args = env["AGENTDESK_VOICE_SERVER_ARGS"]
            .map { $0.split(separator: " ").map(String.init) }
            ?? ["run", "voice-server"]
        return VoiceSidecarLaunch(
            executableURL: URL(fileURLWithPath: uvPath),
            arguments: args,
            workingDirectory: URL(fileURLWithPath: projectDir, isDirectory: true),
            importTimeTraceURL: voiceImportTimeTraceURL
        )
    }

    // Shipped voice provisioning. `uv` and the interaction-agent source are
    // staged into the app bundle by `just build-voice-sidecar`; the venv, uv
    // cache, and fetched models live under Application Support (writable, unsigned,
    // per-user). Returns nil when the bundled inputs are absent, so a build
    // without the staged sidecar simply has no shipped voice path (the env-driven
    // dev launch above still works).
    static let voiceVenvDirectory = applicationSupportDirectory
        .appendingPathComponent("voice-venv", isDirectory: true)
    static let voiceUvCacheDirectory = applicationSupportDirectory
        .appendingPathComponent("voice-uv-cache", isDirectory: true)
    static let voiceDataDirectory = applicationSupportDirectory
        .appendingPathComponent("voice-data", isDirectory: true)
    static let voiceModelDirectory = applicationSupportDirectory
        .appendingPathComponent("voice-models", isDirectory: true)
    /// Where the Python sidecar finds the ZIPA graph.
    ///
    /// The same directory this Mac serves to the phone, rather than a second
    /// copy in the host bundle: it is the identical 67MB file, and bundling it
    /// charged every host build for a resource copy and a code signature to
    /// duplicate something already on disk.
    static var voiceZIPAResourceURL: URL? {
        guard let root = voiceAssetRootURL,
              FileManager.default.fileExists(
                atPath: root.appendingPathComponent("VoiceZIPAModel.onnx").path
              )
        else { return nil }
        return root
    }
    static let voiceSourceResourceName = "voice-src"
    static var voiceSourceURL: URL? {
        Bundle.main.url(forResource: voiceSourceResourceName, withExtension: nil)
    }
    static var voiceUvURL: URL? {
        Bundle.main.url(forResource: "uv", withExtension: nil)
    }
    /// The voice model files this Mac serves to a paired phone.
    ///
    /// These used to ship inside the phone's app bundle, where they were two
    /// thirds of its size and were re-sent on every install despite almost never
    /// changing.
    ///
    /// Kept out of the host bundle deliberately. Xcode copies bundled resources
    /// and code signing then seals them, so ~220MB of models would be paid on
    /// every host build for files that change a few times a year. Application
    /// Support costs the build nothing, survives rebuilds, and is where the
    /// other generated voice assets already live. Absent on a Mac that has never
    /// run `just voice-phone-model` / `just voice-zipa-model`, which the lane
    /// reports as an empty manifest.
    static var voiceAssetRootURL: URL? {
        if let override = ProcessInfo.processInfo.environment["AGENTDESK_VOICE_ASSET_ROOT"] {
            return URL(fileURLWithPath: override)
        }
        return voiceAssetDirectory
    }
    /// Shared across host variants rather than living under the per-bundle-id
    /// Application Support directory the rest of the host state uses.
    ///
    /// That split exists so the stable and dev hosts cannot corrupt each other's
    /// state. These are not state: they are large, read-only, hash-verified
    /// inputs that are byte-identical between variants, so giving each variant
    /// its own copy would cost a spare 220MB to protect against a conflict that
    /// cannot happen.
    static let voiceAssetDirectory = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("AgentDeskVoiceAssets", isDirectory: true)
    static var voiceWheelhouseURL: URL? {
        completeVoiceWheelhouseURL(
            at: Bundle.main.url(forResource: "voice-wheelhouse", withExtension: nil)
        )
    }
    static func completeVoiceWheelhouseURL(at wheelhouse: URL?) -> URL? {
        // The tracked .gitkeep preserves Xcode's folder reference in a fresh
        // checkout. Only the generated checksum manifest proves the complete
        // package house was built and is safe to make authoritative offline.
        guard let wheelhouse else { return nil }
        let manifest = wheelhouse.appendingPathComponent("SHA256SUMS")
        guard FileManager.default.fileExists(atPath: manifest.path) else {
            return nil
        }
        return wheelhouse
    }
    // Content hash of the staged voice source, written by `just
    // build-voice-sidecar` (the same hash that gates its own staging). It stamps
    // the provisioned venv, which holds a COPY of the source: without a stamp
    // that tracks content, editing the Python and relaunching silently keeps
    // running the venv's old code. The app's marketing version cannot carry this
    // — it does not move when the source does.
    static var voiceSourceStageHash: String? {
        guard let sourceURL = voiceSourceURL else { return nil }
        let stamp = sourceURL.appendingPathComponent(voiceSourceStageHashFilename)
        return (try? String(contentsOf: stamp, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static let voiceSourceStageHashFilename = "stage-hash"
    static var voiceProvisionerInputs: VoiceVenvProvisioner.Inputs? {
        guard let uvURL = voiceUvURL, let sourceURL = voiceSourceURL else {
            return nil
        }
        // No stage hash means the source was staged by something other than the
        // build recipe. Bias to a rebuild (a fresh value never matches the
        // stored stamp) rather than risk serving stale code; the provisioner's
        // "voice venv: creating at" line makes the repeat cost visible.
        let stamp = voiceSourceStageHash ?? "unstamped-\(UUID().uuidString)"
        return VoiceVenvProvisioner.Inputs(
            uvURL: uvURL,
            sourceURL: sourceURL,
            venvURL: voiceVenvDirectory,
            cacheURL: voiceUvCacheDirectory,
            wheelhouseURL: voiceWheelhouseURL,
            versionStamp: stamp
        )
    }
    // The launch that runs the provisioned venv's `voice-server` console entry
    // directly (no uv at runtime), pointing data + models at writable
    // Application-Support paths.
    static func provisionedVoiceLaunch(voiceServerExecutable: URL) -> VoiceSidecarLaunch {
        var environment = [
            "VOICE_DATA_ROOT": voiceDataDirectory.path,
            "VOICE_MODEL_ROOT": voiceModelDirectory.path,
        ]
        if let sourceURL = voiceSourceURL {
            environment["VOICE_CMU_DICTIONARY_PATH"] = sourceURL
                .appendingPathComponent("VoiceCMUDictionary.txt")
                .path
            environment["VOICE_PHONE_MAPPING_PATH"] = sourceURL
                .appendingPathComponent("arpabet-model-phone-map.json")
                .path
        }
        if let zipaURL = voiceZIPAResourceURL {
            environment["VOICE_ZIPA_MODEL_ROOT"] = zipaURL.path
        }
        return VoiceSidecarLaunch(
            executableURL: voiceServerExecutable,
            arguments: [],
            workingDirectory: voiceSourceURL,
            environment: environment,
            importTimeTraceURL: voiceImportTimeTraceURL
        )
    }
    static let ptyManagerResourceName = "pty-manager"
    static let ptyVaultResourceName = "pty-vault"
    /// Backstop for a candidate that hangs, not a budget for one that is working.
    ///
    /// A handover transfers one descriptor per session, so it takes longer the more terminals are
    /// open, and the waiter already fails immediately when the candidate process dies. A 5s ceiling
    /// meant a vault with twelve sessions was declared failed at 5.006s while it was still
    /// transferring, throwing away a healthy handover for a cold start. Keep this generous enough
    /// that only a genuinely stuck candidate hits it.
    static let ptyRuntimePeerTimeoutSeconds = positiveDouble(
        environmentKey: "AGENTDESK_PTY_RUNTIME_PEER_TIMEOUT_SECONDS",
        defaultValue: 30
    )
    static let ptyRuntimeIdentityTimeoutSeconds = positiveDouble(
        environmentKey: "AGENTDESK_PTY_RUNTIME_IDENTITY_TIMEOUT_SECONDS",
        defaultValue: 10
    )
    static let agentTerminalHandoffTimeoutSeconds = positiveInt(
        environmentKey: "AGENTDESK_AGENT_TERMINAL_HANDOFF_TIMEOUT_SECONDS",
        defaultValue: 10
    )
    static let agentTerminalRequestTombstoneLimit = positiveInt(
        environmentKey: "AGENTDESK_AGENT_TERMINAL_TOMBSTONE_LIMIT",
        defaultValue: 256
    )
    // Sized for surfaces, not for politeness: every Agents window and every paired phone opens its
    // own long-lived SSE streams (projects, one per watched project, one per open thread, one per
    // session with extension UI) and those connections never come back to the pool. The system
    // default of six per host is exhausted by the third window. Loopback to a sidecar the host
    // spawned itself has no reason to be that frugal.
    static let agentFeedSidecarStreamConnectionLimit = positiveInt(
        environmentKey: "AGENTDESK_AGENT_FEED_SIDECAR_STREAM_CONNECTIONS",
        defaultValue: 64
    )
    // Separate pool, so a request that renders a thread never queues behind a stream that will not
    // end. Small on purpose: these are short round trips, and a backlog here means the sidecar is
    // slow, which more sockets would hide rather than fix.
    static let agentFeedSidecarRequestConnectionLimit = positiveInt(
        environmentKey: "AGENTDESK_AGENT_FEED_SIDECAR_REQUEST_CONNECTIONS",
        defaultValue: 16
    )
    static let workspaceTerminalHandoffTimeoutSeconds = positiveInt(
        environmentKey: "AGENTDESK_WORKSPACE_TERMINAL_HANDOFF_TIMEOUT_SECONDS",
        defaultValue: 10
    )
    static let workspaceTerminalShell =
        ProcessInfo.processInfo.environment["AGENTDESK_WORKSPACE_TERMINAL_SHELL"]
        ?? ProcessInfo.processInfo.environment["SHELL"]
        ?? "/bin/zsh"
    static var ptyManagerURL: URL? {
        Bundle.main.url(forResource: ptyManagerResourceName, withExtension: nil)
    }
    static var ptyVaultURL: URL? {
        Bundle.main.url(forResource: ptyVaultResourceName, withExtension: nil)
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
    static let ptyVaultSocketURL = applicationSupportDirectory
        .appendingPathComponent("pty-vault.sock", isDirectory: false)
    static let adTokenURL = applicationSupportDirectory
        .appendingPathComponent("ad-token", isDirectory: false)
    // R16/R17 workspace consolidation. `workspaceStoreURL` is AgentDesk's authoritative,
    // bundle-scoped workspace store. `donorWorkspaceStoreURL` is the retired agent-workspace-ide
    // store (the repo is tombstoned, ADR-0053) read once at first launch to seed AgentDesk's store
    // — a one-time runtime data migration, not a build dependency. The importer treats an absent
    // donor as a clean empty first run, so a wrong or missing path fails safe.
    static let workspaceStoreURL = applicationSupportDirectory
        .appendingPathComponent("workspaces.json", isDirectory: false)
    static let workspaceIDEStateURL = applicationSupportDirectory
        .appendingPathComponent("workspace-ide-state.json", isDirectory: false)
    static let workspaceIDEDraftsDirectory = applicationSupportDirectory
        .appendingPathComponent("WorkspaceIDE/Drafts", isDirectory: true)
    /// The open IDE window set. Each descriptor owns one window's verified Desktop, frame, and local
    /// presentation state, so restart restoration has one authoritative record per instance.
    static let workspaceIDEWindowPresentationsURL = applicationSupportDirectory
        .appendingPathComponent("workspace-ide-window-presentations.json", isDirectory: false)
    static let terminalWindowPresentationsURL = applicationSupportDirectory
        .appendingPathComponent("terminal-window-presentations.json", isDirectory: false)
    /// Where each open Agents window was, so a host restart puts them all back. A file rather than
    /// a frame autosave name because these windows are multi-instance and the set of them is itself
    /// the state; AppKit's autosave holds one frame per name.
    static let agentWindowPresentationsURL = applicationSupportDirectory
        .appendingPathComponent("agent-window-presentations.json", isDirectory: false)
    static let donorWorkspaceStoreURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("agent-workspace-ide/workspace.json", isDirectory: false)
    // R26 authenticated Files lane: the maximum UTF-8 text payload the host will read from or
    // accept for a single file, bounding host memory and wire size. Env-overridable.
    static let workspaceFileMaxBytes = positiveInt(
        environmentKey: "AGENTDESK_WORKSPACE_FILE_MAX_BYTES",
        defaultValue: 4 * 1024 * 1024
    )
    static let workspaceDocumentMaxBytes: Int = {
        let value = positiveInt(
            environmentKey: "AGENTDESK_WORKSPACE_DOCUMENT_MAX_BYTES",
            defaultValue: WorkspaceLaneCodec.maximumDocumentBytes
        )
        precondition(
            value <= WorkspaceLaneCodec.maximumDocumentBytes,
            "AGENTDESK_WORKSPACE_DOCUMENT_MAX_BYTES exceeds the Files wire budget"
        )
        return value
    }()
    // macOS workspace shell (R20/R23; reveal chrome ADR-0054). On by default: starting the host
    // starts the whole shell (the floating, all-Spaces, reveal-on-hover sidebar + top bar). Set the
    // env override to 0 to disable (CI and any host run that must not show the shell).
    static let workspaceShellEnabled: Bool = enabledFlag(
        environmentKey: "AGENTDESK_WORKSPACE_SHELL_ENABLED",
        defaultValue: true,
        environment: ProcessInfo.processInfo.environment
    )
    static let yabaiURL = yabaiURL(
        environment: ProcessInfo.processInfo.environment,
        homeDirectory: FileManager.default.homeDirectoryForCurrentUser
    )
    static let yabaiCommandTimeoutSeconds = positiveDouble(
        environmentKey: "AGENTDESK_YABAI_COMMAND_TIMEOUT_SECONDS",
        defaultValue: 5
    )

    static func yabaiURL(environment: [String: String], homeDirectory: URL) -> URL {
        guard let raw = environment["AGENTDESK_YABAI_PATH"]?.trimmingCharacters(in: .whitespaces),
              !raw.isEmpty
        else {
            return homeDirectory.appendingPathComponent(".local/bin/yabai", isDirectory: false)
        }
        if raw == "~" { return homeDirectory }
        if raw.hasPrefix("~/") {
            return homeDirectory.appendingPathComponent(String(raw.dropFirst(2)), isDirectory: false)
        }
        return URL(fileURLWithPath: raw, isDirectory: false)
    }
    // Dev-only AX automation mode: run the host as a regular app so macOS exposes
    // its windows to out-of-process Accessibility clients during repository-local
    // automation. Off by default so daily-driver behavior stays LSUIElement-based.
    static let axAutomationEnabled: Bool = enabledFlag(
        environmentKey: "AGENTDESK_AX_AUTOMATION_ENABLED",
        defaultValue: false,
        environment: ProcessInfo.processInfo.environment
    )
    static let axAutomationPreservesFocus: Bool = axAutomationEnabled && enabledFlag(
        environmentKey: "AGENTDESK_AX_AUTOMATION_PRESERVE_FOCUS",
        defaultValue: false,
        environment: ProcessInfo.processInfo.environment
    )
    static let agentResumeExecutables = agentResumeExecutables(
        environment: ProcessInfo.processInfo.environment
    )

    static func agentResumeExecutables(environment: [String: String]) -> AgentResumeLaunch.Executables {
        AgentResumeLaunch.Executables(
            claude: environment["AGENTDESK_CLAUDE_EXECUTABLE"].flatMap { $0.isEmpty ? nil : $0 }
                ?? "claude",
            codex: environment["AGENTDESK_CODEX_EXECUTABLE"].flatMap { $0.isEmpty ? nil : $0 }
                ?? "codex"
        )
    }
    // Optional workspace root registered on first launch when the store is empty, so the Files
    // surface has something to browse before the macOS workspace shell (R20/R21) exists to let the
    // user add roots. No default: unset means nothing is auto-registered.
    static let defaultWorkspaceRoot: URL? = {
        guard let path = ProcessInfo.processInfo.environment["AGENTDESK_DEFAULT_WORKSPACE_ROOT"],
              !path.isEmpty
        else { return nil }
        return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
    }()
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
    static let devClientDebugRequestPath = applicationSupportDirectory
        .appendingPathComponent(".client-debug-request.json", isDirectory: false)
    static let devClientDebugResultPath = applicationSupportDirectory
        .appendingPathComponent(".client-debug-result.json", isDirectory: false)
    static let clientTelemetryDirectory = applicationSupportDirectory
        .appendingPathComponent("ClientTelemetry", isDirectory: true)
    static let clientTelemetryMaxRunsPerDevice = 8
    static let clientTelemetryMaxBytesPerDevice = 16 * 1_024 * 1_024
    static let diagnosticsRequestTimeoutSeconds: TimeInterval = 20
    static let screenshotRequestTimeoutSeconds: TimeInterval = 20
    static let screenshotMaxPixelDimension = 2_048
    static let screenshotMaxBytes = 4 * 1_024 * 1_024
    static let screenshotChunkBytes = 256 * 1_024
    static let clientDebugAutomationRequestMaxBytes = 64 * 1_024
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
