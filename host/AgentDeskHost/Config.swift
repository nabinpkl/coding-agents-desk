import Foundation

enum Config {
    enum MediaStackMode: String {
        case webrtc
        case owned

        init(rawEnvironmentValue: String?) {
            switch rawEnvironmentValue?.lowercased() {
            case "owned":
                self = .owned
            default:
                self = .webrtc
            }
        }

        var mediaMode: MediaMode {
            switch self {
            case .webrtc: .webrtc
            case .owned: .owned
            }
        }
    }

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
    static let nonceTTL: TimeInterval = 90
    static let inputCapabilityTTL: TimeInterval = 60
    static let mediaCapabilityTTL: TimeInterval = 60
    static let mediaStackMode = MediaStackMode(
        rawEnvironmentValue: ProcessInfo.processInfo.environment["AGENTDESK_MEDIA_STACK"]
    )
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
    static let ownedMediaDetailActive: Bool = {
        ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_DETAIL_ACTIVE"] != "0"
    }()
    static let ownedMediaMotionActive: Bool = {
        ProcessInfo.processInfo.environment["AGENTDESK_OWNED_MEDIA_MOTION_ACTIVE"] != "0"
    }()
    static var ownedMediaActivePlanes: [MediaPlane] {
        var planes: [MediaPlane] = []
        if ownedMediaDetailActive {
            planes.append(.detail)
        }
        if ownedMediaMotionActive {
            planes.append(.motion)
        }
        return planes.isEmpty ? [.detail] : planes
    }
    static func ownedMediaMaxQP(environment: [String: String]) -> Int? {
        guard let raw = environment["AGENTDESK_OWNED_MEDIA_MAX_QP"],
              let value = Int(raw),
              value > 0
        else {
            return nil
        }
        return value
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
