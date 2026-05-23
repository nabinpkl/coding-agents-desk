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

    // Raw payloads from the client-side input data channel. The transport
    // does not decode; the consumer feeds bytes into a JSONDecoder for
    // NormalizedInput. R9.1.
    var inputEvents: AsyncStream<Data> { get }
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
    var bweMinKbps: Int
    var bweStartKbps: Int
    var bweMaxKbps: Int

    enum DegradationPreference: String, Equatable {
        case disabled
        case maintainFramerate
        case maintainResolution
        case balanced
    }

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
        bweMinKbps: 2_000,
        bweStartKbps: 6_000,
        bweMaxKbps: 8_000
    )

    // Reads AGENTDESK_TUNING_<FIELD> env vars over the default. Examples:
    //   AGENTDESK_TUNING_DEGRADATION=maintainResolution
    //   AGENTDESK_TUNING_MAX_BITRATE_KBPS=12000
    //   AGENTDESK_TUNING_SCREENCAST=0
    // Leaves fields untouched when the env var is absent.
    static func fromEnvironment() -> SenderTuning {
        var t = SenderTuning.default
        let env = ProcessInfo.processInfo.environment
        if let v = env["AGENTDESK_TUNING_SCREENCAST"] { t.screencast = (v == "1") }
        if let v = env["AGENTDESK_TUNING_DEGRADATION"],
           let dp = DegradationPreference(rawValue: v) { t.degradationPreference = dp }
        if let v = env["AGENTDESK_TUNING_MAX_BITRATE_KBPS"], let n = Int(v) { t.maxBitrateKbps = n }
        if let v = env["AGENTDESK_TUNING_MIN_BITRATE_KBPS"], let n = Int(v) { t.minBitrateKbps = n }
        if let v = env["AGENTDESK_TUNING_MAX_FPS"], let n = Int(v) { t.maxFramerate = n }
        if let v = env["AGENTDESK_TUNING_BWE_MIN_KBPS"], let n = Int(v) { t.bweMinKbps = n }
        if let v = env["AGENTDESK_TUNING_BWE_START_KBPS"], let n = Int(v) { t.bweStartKbps = n }
        if let v = env["AGENTDESK_TUNING_BWE_MAX_KBPS"], let n = Int(v) { t.bweMaxKbps = n }
        return t
    }
}

enum MediaTransportError: Error {
    case notYetImplemented
}

// Marker protocol so MediaTransport.start carries one signature on both
// sides. The concrete view type is platform-specific and accessed via the
// impl, not the protocol; the host never instantiates a sink.
protocol VideoFrameSink: AnyObject {}
