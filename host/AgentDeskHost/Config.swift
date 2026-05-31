import Foundation

enum Config {
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

    static let signalingPort: UInt16 = 41888
    static let nonceTTL: TimeInterval = 90
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
    // App opened by the terminal-launcher pill. Override with AGENTDESK_TERMINAL_APP
    // (a path to a .app, e.g. /Applications/iTerm.app) to use iTerm2, Ghostty,
    // etc. Defaults to the system Terminal.
    // App opened by the terminal-launcher pill. Override with
    // AGENTDESK_TERMINAL_APP (a path to a .app, e.g. /Applications/iTerm.app)
    // to use iTerm2, Ghostty, etc. Defaults to the system Terminal.
    static let terminalAppURL: URL = {
        if let raw = ProcessInfo.processInfo.environment["AGENTDESK_TERMINAL_APP"],
           !raw.isEmpty {
            return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath)
        }
        return URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
    }()
    static let launchAgentLabel = "com.example.agentdesk.AgentDeskHost"
    static let applicationSupportDirectory = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("AgentDesk", isDirectory: true)
    static let pairedDevicesURL = applicationSupportDirectory
        .appendingPathComponent("paired-devices.json", isDirectory: false)
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
