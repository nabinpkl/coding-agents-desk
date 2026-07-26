import CoreGraphics
import Foundation
import AgentDeskWire

// UserDefaults-backed store for trackpad / scroll feel preferences. The
// raw values are unitless multipliers (1.0 = default) so the UI can show
// them as "1.0x", "1.5x" sliders without translation. SettingsViewController
// writes here; GestureTranslator and PairingViewController read.
//
// Changes post a single notification so observers can refresh without
// having to wire individual KVO on each property. Observers re-read the
// small settings payload instead of tracking which one changed.
final class SettingsStore: @unchecked Sendable {
    static let shared = SettingsStore()

    static let changedNotification = Notification.Name("com.example.agentdesk.AgentDeskClient.settingsChanged")

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private enum Key {
        static let cursorSpeed = "agentDesk.cursorSpeed"
        static let cursorAccel = "agentDesk.cursorAcceleration"
        static let scrollSpeed = "agentDesk.scrollSpeed"
        static let scrollInverted = "agentDesk.scrollInverted"
        static let useMacOSSpacesDirection = "agentDesk.useMacOSSpacesDirection"
        static let accessoryContainerHeight = "agentDesk.accessoryContainerHeight"
        static let accessoryKeyHeight = "agentDesk.accessoryKeyHeight"
        static let accessoryKeySpacing = "agentDesk.accessoryKeySpacing"
        static let showSpacePreviews = "agentDesk.showSpacePreviews"
        static let videoTouchEnabled = "agentDesk.videoTouchEnabled"
        static let videoLayoutMode = "agentDesk.videoLayoutMode"
        static let autoKeyboardEnabled = "agentDesk.autoKeyboardEnabled"
        static let crispTextOverlayEnabled = "agentDesk.crispTextOverlayEnabled"
        static let showHostCursorInVideo = "agentDesk.showHostCursorInVideo"
        static let adaptiveMediaQualityEnabled = "agentDesk.adaptiveMediaQualityEnabled"
        static let manualMediaBitrateKbps = "agentDesk.manualMediaBitrateKbps"
        static let manualMediaFps = "agentDesk.manualMediaFps"
        static let manualMediaResolutionScale = "agentDesk.manualMediaResolutionScale"
        static let domMirrorEnabled = "agentDesk.domMirrorEnabled"
        static let agentSayVoiceLanguage = "agentDesk.agentSayVoiceLanguage"
        static let agentSayVoiceIdentifier = "agentDesk.agentSayVoiceIdentifier"
        static let diagnosticScreenshotsEnabled = "agentDesk.diagnosticScreenshotsEnabled"
    }

    // iOS HIG / QuickType bar standard is 44pt; key chiclets at 36pt
    // leave 4pt of breathing room top and bottom. Match that so the
    // accessory row reads as part of the system keyboard, not a stranger.
    static let defaultAccessoryContainerHeight: Double = 44
    static let defaultAccessoryKeyHeight: Double = 36
    static let defaultAccessoryKeySpacing: Double = 6
    static let defaultManualMediaBitrateKbps = 2_500
    static let manualMediaBitrateKbpsRange: ClosedRange<Int> = 180...5_000
    static let defaultManualMediaFps = 30
    static let manualMediaFpsValues = [1, 6, 10, 15, 24, 30]
    static let defaultManualMediaResolutionScale = 1.0
    static let manualMediaResolutionScaleValues = [0.33, 0.5, 0.75, 1.0]

    // Materialize the current tuning as one value. PairingViewController
    // copies this onto the translator on each change; SettingsViewController
    // still writes individual fields as the user drags each slider.
    var tuning: GestureTuning {
        GestureTuning(
            cursorSpeed: CGFloat(cursorSpeed),
            cursorAcceleration: CGFloat(cursorAcceleration),
            scrollSpeed: CGFloat(scrollSpeed),
            scrollInverted: scrollInverted
        )
    }

    var cursorSpeed: Double {
        get { defaults.object(forKey: Key.cursorSpeed) as? Double ?? 1.0 }
        set {
            defaults.set(newValue, forKey: Key.cursorSpeed)
            postChange()
        }
    }

    var cursorAcceleration: Double {
        get { defaults.object(forKey: Key.cursorAccel) as? Double ?? 1.0 }
        set {
            defaults.set(newValue, forKey: Key.cursorAccel)
            postChange()
        }
    }

    var scrollSpeed: Double {
        get { defaults.object(forKey: Key.scrollSpeed) as? Double ?? 1.0 }
        set {
            defaults.set(newValue, forKey: Key.scrollSpeed)
            postChange()
        }
    }

    // Default false = natural scroll (finger up moves content up, matching
    // iOS Safari). Setting to true flips the sign for traditional /
    // mouse-wheel-style scrolling.
    var scrollInverted: Bool {
        get { defaults.bool(forKey: Key.scrollInverted) }
        set {
            defaults.set(newValue, forKey: Key.scrollInverted)
            postChange()
        }
    }

    // Default false (toggle off) = inverted-from-native direction:
    // finger-right on the dots band switches to the Space on the LEFT
    // (i.e., reads the band like a horizontal scroll bar where dragging
    // right reveals what is to the right). Most one-handed phone users
    // expect this. Setting to true reverts to the macOS-native trackpad
    // direction where finger-right -> next Space.
    //
    // SpacesDotsView reads this and applies the sign flip in emit()
    // when false; the host never has to know about user preference.
    var useMacOSSpacesDirection: Bool {
        get { defaults.bool(forKey: Key.useMacOSSpacesDirection) }
        set {
            defaults.set(newValue, forKey: Key.useMacOSSpacesDirection)
            postChange()
        }
    }

    // Whole accessory bar height in points. Drives both the inputAccessoryView
    // frame and its intrinsicContentSize so iOS sizes the container the
    // same way every render.
    var accessoryContainerHeight: Double {
        get { defaults.object(forKey: Key.accessoryContainerHeight) as? Double ?? Self.defaultAccessoryContainerHeight }
        set { defaults.set(newValue, forKey: Key.accessoryContainerHeight); postChange() }
    }

    // Per-key height. Smaller than container leaves top/bottom padding;
    // equal to container makes keys flush.
    var accessoryKeyHeight: Double {
        get { defaults.object(forKey: Key.accessoryKeyHeight) as? Double ?? Self.defaultAccessoryKeyHeight }
        set { defaults.set(newValue, forKey: Key.accessoryKeyHeight); postChange() }
    }

    // Gap between adjacent keys in points.
    var accessoryKeySpacing: Double {
        get { defaults.object(forKey: Key.accessoryKeySpacing) as? Double ?? Self.defaultAccessoryKeySpacing }
        set { defaults.set(newValue, forKey: Key.accessoryKeySpacing); postChange() }
    }

    // ADR-0006: Spaces preview strip. Default OFF; mirroring non-active-Space
    // contents to the phone is opt-in for trust reasons, and the strip is not
    // wanted by default. Users who want the at-a-glance thumbnails flip it on
    // in settings. PairingViewController reads this on input-channel open and
    // on settings change, sends a ClientConfig frame, and mounts / unmounts
    // the strip.
    var showSpacePreviews: Bool {
        get { defaults.object(forKey: Key.showSpacePreviews) as? Bool ?? false }
        set {
            defaults.set(newValue, forKey: Key.showSpacePreviews)
            postChange()
        }
    }

    // Crisp text overlay preference. Sent to the host in ClientConfig (wire key "ce"); the
    // host composes it with its own gate so this only turns the overlay off, never forces it
    // on when the host disabled it. Default OFF -- the plain video stream is the default;
    // users opt into the sharper (heavier) overlay in settings.
    var crispTextOverlayEnabled: Bool {
        get { defaults.object(forKey: Key.crispTextOverlayEnabled) as? Bool ?? false }
        set {
            defaults.set(newValue, forKey: Key.crispTextOverlayEnabled)
            postChange()
        }
    }

    // Whether the host bakes its OS cursor into the video stream. Sent to the host in
    // ClientConfig (wire key "hc"). Default OFF: the client already draws its own sharp,
    // low-latency cursor overlay, so the baked-in video cursor is a redundant, laggier
    // double-draw. On is for parity/debugging or clients without the overlay.
    var showHostCursorInVideo: Bool {
        get { defaults.object(forKey: Key.showHostCursorInVideo) as? Bool ?? false }
        set {
            defaults.set(newValue, forKey: Key.showHostCursorInVideo)
            postChange()
        }
    }

    // Host-owned adaptive media ladder. Default ON: the host should keep motion alive on
    // constrained links unless the user explicitly pins the stream to a manual target.
    // Sent in ClientConfig.mediaQuality (wire key "mq") and applied live by the host transport.
    var adaptiveMediaQualityEnabled: Bool {
        get { defaults.object(forKey: Key.adaptiveMediaQualityEnabled) as? Bool ?? true }
        set {
            defaults.set(newValue, forKey: Key.adaptiveMediaQualityEnabled)
            postChange()
        }
    }

    var manualMediaBitrateKbps: Int {
        get { defaults.object(forKey: Key.manualMediaBitrateKbps) as? Int ?? Self.defaultManualMediaBitrateKbps }
        set {
            defaults.set(
                clamp(newValue, min: Self.manualMediaBitrateKbpsRange.lowerBound, max: Self.manualMediaBitrateKbpsRange.upperBound),
                forKey: Key.manualMediaBitrateKbps
            )
            postChange()
        }
    }

    var manualMediaFps: Int {
        get { defaults.object(forKey: Key.manualMediaFps) as? Int ?? Self.defaultManualMediaFps }
        set {
            let nearest = Self.manualMediaFpsValues.min { abs($0 - newValue) < abs($1 - newValue) } ?? Self.defaultManualMediaFps
            defaults.set(nearest, forKey: Key.manualMediaFps)
            postChange()
        }
    }

    var manualMediaResolutionScale: Double {
        get { defaults.object(forKey: Key.manualMediaResolutionScale) as? Double ?? Self.defaultManualMediaResolutionScale }
        set {
            let nearest = Self.manualMediaResolutionScaleValues.min { abs($0 - newValue) < abs($1 - newValue) } ?? Self.defaultManualMediaResolutionScale
            defaults.set(nearest, forKey: Key.manualMediaResolutionScale)
            postChange()
        }
    }

    var mediaQualityConfig: ClientMediaQualityConfig {
        ClientMediaQualityConfig(
            adaptiveEnabled: adaptiveMediaQualityEnabled,
            fixedTarget: adaptiveMediaQualityEnabled ? nil : ClientMediaQualityTarget(
                bitrateKbps: manualMediaBitrateKbps,
                fps: manualMediaFps,
                resolutionScale: manualMediaResolutionScale
            )
        )
    }

    // Video touch input routing, layout density, and automatic keyboard opening are
    // independent. Defaults: As Is layout, video-surface touch mode off, auto-key on.
    var videoTouchEnabled: Bool {
        get { defaults.object(forKey: Key.videoTouchEnabled) as? Bool ?? false }
        set {
            defaults.set(newValue, forKey: Key.videoTouchEnabled)
            postChange()
        }
    }

    var videoLayoutMode: VideoLayoutMode {
        get {
            guard let raw = defaults.object(forKey: Key.videoLayoutMode) as? String else {
                return .asIs
            }
            return VideoLayoutMode(rawValue: raw) ?? .asIs
        }
        set {
            defaults.set(newValue.rawValue, forKey: Key.videoLayoutMode)
            postChange()
        }
    }

    var autoKeyboardEnabled: Bool {
        get { defaults.object(forKey: Key.autoKeyboardEnabled) as? Bool ?? true }
        set {
            defaults.set(newValue, forKey: Key.autoKeyboardEnabled)
            postChange()
        }
    }

    // Screen pixels can contain terminal, browser, or remote desktop content,
    // so paired-host screenshot requests require an explicit one-time opt-in.
    var diagnosticScreenshotsEnabled: Bool {
        get { defaults.object(forKey: Key.diagnosticScreenshotsEnabled) as? Bool ?? false }
        set {
            defaults.set(newValue, forKey: Key.diagnosticScreenshotsEnabled)
            postChange()
        }
    }

    func setRemoteInputModes(
        layoutMode: VideoLayoutMode,
        videoTouchEnabled: Bool,
        autoKeyboardEnabled: Bool
    ) {
        defaults.set(layoutMode.rawValue, forKey: Key.videoLayoutMode)
        defaults.set(videoTouchEnabled, forKey: Key.videoTouchEnabled)
        defaults.set(autoKeyboardEnabled, forKey: Key.autoKeyboardEnabled)
        postChange()
    }

    // ADR-0038 DOM mirror. Baked on by default for all variants. Gates whether the client opens the
    // .dom lane and shows the replay surface; the host still gates with its own flag. An env override
    // (`AGENTDESK_DOM_MIRROR_ENABLED=1`/`0`) wins, so a physical-device run can force it via the
    // devicectl `--environment-variables` path (devicectl apps get env, not argv). Absent both an env
    // override and a stored choice, it defaults on; a stored value (in-app toggle, or the sim
    // `-agentDesk.domMirrorEnabled NO` argument domain) still wins. A prior revert suspected the .dom
    // lane of breaking pairing, but that was a tailnet-instability confound (transient -9858), not DOM.
    var domMirrorEnabled: Bool {
        get {
            if let env = ProcessInfo.processInfo.environment["AGENTDESK_DOM_MIRROR_ENABLED"] {
                return env == "1" || env.lowercased() == "true"
            }
            guard defaults.object(forKey: Key.domMirrorEnabled) != nil else {
                return true
            }
            return defaults.bool(forKey: Key.domMirrorEnabled)
        }
        set {
            defaults.set(newValue, forKey: Key.domMirrorEnabled)
            postChange()
        }
    }

    var agentSayVoiceIdentifier: String? {
        get { defaults.string(forKey: Key.agentSayVoiceIdentifier) }
        set {
            if let newValue {
                defaults.set(newValue, forKey: Key.agentSayVoiceIdentifier)
            } else {
                defaults.removeObject(forKey: Key.agentSayVoiceIdentifier)
            }
            postChange()
        }
    }

    var agentSayVoiceLanguage: String? {
        get { defaults.string(forKey: Key.agentSayVoiceLanguage) }
        set {
            if let newValue {
                defaults.set(newValue, forKey: Key.agentSayVoiceLanguage)
            } else {
                defaults.removeObject(forKey: Key.agentSayVoiceLanguage)
            }
            postChange()
        }
    }

    private func postChange() {
        NotificationCenter.default.post(name: Self.changedNotification, object: self)
    }

    private func clamp<T: Comparable>(_ value: T, min lower: T, max upper: T) -> T {
        Swift.min(Swift.max(value, lower), upper)
    }
}
