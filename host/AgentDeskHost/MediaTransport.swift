import Foundation

// ADR-0004 protocol seam. Anything that wants to swap WebRTC stacks, codecs,
// renderers, or capturers does it behind this surface. The only files that
// import WebRTC are the LibWebRTC* impls; AppDelegate holds a
// MediaTransportFactory by protocol.

protocol MediaTransport: AnyObject, Sendable {
    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSource: VideoFrameSource?,
        videoSink: VideoFrameSink?
    ) async throws

    func stop()

    // Single-consumer stream. Impls construct one continuation per instance.
    var connectionState: AsyncStream<MediaConnectionState> { get }

    // Drop to the low-latency scroll profile (active=true) or restore the
    // crisp profile (active=false). Driven by client interaction hints.
    // Impls debounce the restore so rapid repeated strokes don't flicker.
    func setVideoInteractive(_ active: Bool)
}

enum MediaTransportRole {
    case offerer
    case answerer
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

// Codec choice is data, not code. v0 ships [.h264]; HEVC flip is one line in
// MediaStack. Order is preference; the underlying impl negotiates the first
// supported case.
struct MediaCodecPreferences: Equatable {
    var preferred: [VideoCodec]

    enum VideoCodec: String, Equatable, Codable {
        case h264
        case h265
        case vp8
        case vp9
        case av1
    }

    static let h264Only = MediaCodecPreferences(preferred: [.h264])
    static let vp9First = MediaCodecPreferences(preferred: [.vp9, .h264])
    static let av1First = MediaCodecPreferences(preferred: [.av1, .vp9, .h264])

    var preferredCodecNames: [String] {
        preferred.map { codec in
            switch codec {
            case .h264: return "H264"
            case .h265: return "H265"
            case .vp8: return "VP8"
            case .vp9: return "VP9"
            case .av1: return "AV1"
            }
        }
    }

    func allows(statsMimeType: String) -> Bool {
        guard let subtype = statsMimeType.split(separator: "/").last else { return false }
        return preferredCodecNames.contains(String(subtype).uppercased())
    }
}

struct CodecCapabilityDescriptor: Equatable {
    let index: Int
    let name: String
    let preferredPayloadType: String?
    let aptPayloadType: String?
}

enum CodecPreferencePolicy {
    private static let primaryNames: Set<String> = ["H264", "H265", "VP8", "VP9", "AV1"]
    private static let protectionNames: Set<String> = ["RED", "ULPFEC", "FLEXFEC-03"]

    static func orderedAllowedIndexes(
        capabilities: [CodecCapabilityDescriptor],
        preferences: MediaCodecPreferences
    ) -> [Int] {
        var selectedMedia: [CodecCapabilityDescriptor] = []
        for name in preferences.preferredCodecNames {
            selectedMedia.append(
                contentsOf: capabilities.filter {
                    normalize($0.name) == name && isPrimary($0)
                }
            )
        }

        let mediaAndRepairIndexes = selectedMedia.flatMap { media -> [Int] in
            let repairIndexes = media.preferredPayloadType.map { payloadType in
                capabilities
                    .filter { isRtx($0) && $0.aptPayloadType == payloadType }
                    .map(\.index)
            } ?? []
            return [media.index] + repairIndexes
        }
        let protectionIndexes = capabilities
            .filter(isProtection)
            .map(\.index)
        return unique(mediaAndRepairIndexes + protectionIndexes)
    }

    private static func isPrimary(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        primaryNames.contains(normalize(descriptor.name))
    }

    private static func isRtx(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        normalize(descriptor.name) == "RTX"
    }

    private static func isProtection(_ descriptor: CodecCapabilityDescriptor) -> Bool {
        protectionNames.contains(normalize(descriptor.name))
    }

    private static func normalize(_ name: String) -> String {
        name.uppercased()
    }

    private static func unique(_ indexes: [Int]) -> [Int] {
        indexes.reduce([]) { ordered, index in
            ordered.contains(index) ? ordered : ordered + [index]
        }
    }
}

// Sender-side tuning knobs. All previously hardcoded inside
// LibWebRTCMediaTransport; lifted here so MediaStack can rebuild them
// from env vars at startup and you can A/B without recompiling.
struct SenderTuning: Equatable {
    var screencast: Bool
    var degradationPreference: DegradationPreference
    var maxBitrateKbps: Int
    var minBitrateKbps: Int
    var maxFramerate: Int
    var baseScaleDownBy: Double
    var bweMinKbps: Int
    var bweStartKbps: Int
    var bweMaxKbps: Int
    // Scroll/interactive profile: while the client is scrolling, downscale
    // resolution and cap bitrate hard so the full-frame motion encodes into
    // small frames that clear the encoder + pacer + network fast (this is
    // the latency lever, not just smoothness), raise the framerate ceiling,
    // and use a maintainFramerate degradation preference. Restored to the
    // crisp values after scrollSettleMs of no interaction.
    var scrollScaleDownBy: Double
    var scrollMaxFramerate: Int
    var scrollMaxBitrateKbps: Int
    var scrollMinBitrateKbps: Int
    var scrollSettleMs: Int
    // VP9 temporal SVC. With layers > 1 the stream carries a base layer
    // plus enhancement layers; squeezing bitrate (the scroll profile) makes
    // the encoder shed the top layers instantly, dropping framerate with no
    // resolution reconfig and no keyframe. Kept constant across profiles so
    // the layer structure never changes (changing it would force a reinit).
    var temporalLayers: Int

    enum DegradationPreference: String, Equatable {
        case disabled
        case maintainFramerate
        case maintainResolution
        case balanced
    }

    // Encoding values applied to the sender for a given mode. Pure data so
    // the derivation is testable without a live WebRTC sender.
    struct EncodingProfile: Equatable {
        var scaleResolutionDownBy: Double
        var maxFramerate: Int
        var maxBitrateKbps: Int
        var minBitrateKbps: Int
        var temporalLayers: Int
        var degradation: DegradationPreference
    }

    var crispProfile: EncodingProfile {
        EncodingProfile(
            scaleResolutionDownBy: baseScaleDownBy,
            maxFramerate: maxFramerate,
            maxBitrateKbps: maxBitrateKbps,
            minBitrateKbps: minBitrateKbps,
            temporalLayers: temporalLayers,
            degradation: degradationPreference
        )
    }

    var scrollProfile: EncodingProfile {
        EncodingProfile(
            scaleResolutionDownBy: scrollScaleDownBy,
            maxFramerate: scrollMaxFramerate,
            maxBitrateKbps: scrollMaxBitrateKbps,
            minBitrateKbps: scrollMinBitrateKbps,
            temporalLayers: temporalLayers,
            degradation: .maintainFramerate
        )
    }

    static let h264HardwareEncoderScaleDownBy = 3.5

    // The current shipping defaults (commit history shows how we arrived
    // here). Paired with codecs=.vp9First in MediaStack: VP9's screen-content
    // mode handles block-skip on static text, so maintainResolution can drop
    // fps under pressure without losing visual quality. With H.264 this
    // combination caused text flicker; with VP9 it's the right tradeoff.
    // Any env-var override in fromEnvironment() replaces individual fields.
    static let `default` = SenderTuning(
        screencast: true,
        degradationPreference: .maintainResolution,
        maxBitrateKbps: 8_000,
        minBitrateKbps: 2_000,
        maxFramerate: 30,
        baseScaleDownBy: 1.0,
        bweMinKbps: 2_000,
        bweStartKbps: 6_000,
        bweMaxKbps: 8_000,
        scrollScaleDownBy: 3.0,
        scrollMaxFramerate: 60,
        scrollMaxBitrateKbps: 3_500,
        scrollMinBitrateKbps: 1_000,
        scrollSettleMs: 300,
        temporalLayers: 3
    )

    // Reads AGENTDESK_TUNING_<FIELD> env vars over the default. Examples:
    //   AGENTDESK_TUNING_DEGRADATION=maintainResolution
    //   AGENTDESK_TUNING_MAX_BITRATE_KBPS=12000
    //   AGENTDESK_TUNING_SCREENCAST=0
    // Leaves fields untouched when the env var is absent.
    static func fromEnvironment() -> SenderTuning {
        let env = ProcessInfo.processInfo.environment
        let defaults = SenderTuning.default
        return SenderTuning(
            screencast: env["AGENTDESK_TUNING_SCREENCAST"].map { $0 == "1" } ?? defaults.screencast,
            degradationPreference: env["AGENTDESK_TUNING_DEGRADATION"].flatMap(DegradationPreference.init(rawValue:)) ?? defaults.degradationPreference,
            maxBitrateKbps: env["AGENTDESK_TUNING_MAX_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.maxBitrateKbps,
            minBitrateKbps: env["AGENTDESK_TUNING_MIN_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.minBitrateKbps,
            maxFramerate: env["AGENTDESK_TUNING_MAX_FPS"].flatMap(Int.init) ?? defaults.maxFramerate,
            baseScaleDownBy: env["AGENTDESK_TUNING_SCALE_DOWN"].flatMap(Double.init) ?? defaults.baseScaleDownBy,
            bweMinKbps: env["AGENTDESK_TUNING_BWE_MIN_KBPS"].flatMap(Int.init) ?? defaults.bweMinKbps,
            bweStartKbps: env["AGENTDESK_TUNING_BWE_START_KBPS"].flatMap(Int.init) ?? defaults.bweStartKbps,
            bweMaxKbps: env["AGENTDESK_TUNING_BWE_MAX_KBPS"].flatMap(Int.init) ?? defaults.bweMaxKbps,
            scrollScaleDownBy: env["AGENTDESK_TUNING_SCROLL_SCALE_DOWN"].flatMap(Double.init) ?? defaults.scrollScaleDownBy,
            scrollMaxFramerate: env["AGENTDESK_TUNING_SCROLL_MAX_FPS"].flatMap(Int.init) ?? defaults.scrollMaxFramerate,
            scrollMaxBitrateKbps: env["AGENTDESK_TUNING_SCROLL_MAX_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.scrollMaxBitrateKbps,
            scrollMinBitrateKbps: env["AGENTDESK_TUNING_SCROLL_MIN_BITRATE_KBPS"].flatMap(Int.init) ?? defaults.scrollMinBitrateKbps,
            scrollSettleMs: env["AGENTDESK_TUNING_SCROLL_SETTLE_MS"].flatMap(Int.init) ?? defaults.scrollSettleMs,
            temporalLayers: env["AGENTDESK_TUNING_TEMPORAL_LAYERS"].flatMap(Int.init) ?? defaults.temporalLayers
        )
    }

    func applyingCodecGuardrails(for codecs: MediaCodecPreferences) -> SenderTuning {
        guard codecs.preferred == [.h264] else { return self }
        return SenderTuning(
            screencast: screencast,
            degradationPreference: .maintainFramerate,
            maxBitrateKbps: maxBitrateKbps,
            minBitrateKbps: minBitrateKbps,
            maxFramerate: maxFramerate,
            baseScaleDownBy: max(baseScaleDownBy, Self.h264HardwareEncoderScaleDownBy),
            bweMinKbps: bweMinKbps,
            bweStartKbps: bweStartKbps,
            bweMaxKbps: bweMaxKbps,
            scrollScaleDownBy: max(scrollScaleDownBy, Self.h264HardwareEncoderScaleDownBy),
            scrollMaxFramerate: scrollMaxFramerate,
            scrollMaxBitrateKbps: scrollMaxBitrateKbps,
            scrollMinBitrateKbps: scrollMinBitrateKbps,
            scrollSettleMs: scrollSettleMs,
            temporalLayers: 1
        )
    }
}

enum MediaTransportError: Error {
    case notYetImplemented
    case unsupportedCodecPreference(String)
}

// Marker protocol so MediaTransport.start carries one signature on both
// sides. The concrete view type is platform-specific and accessed via the
// impl, not the protocol; the host never instantiates a sink.
protocol VideoFrameSink: AnyObject {}
