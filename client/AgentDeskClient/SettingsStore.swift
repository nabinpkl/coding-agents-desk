import CoreGraphics
import Foundation

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

    private let defaults = UserDefaults.standard

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
        static let crispTextOverlayEnabled = "agentDesk.crispTextOverlayEnabled"
        static let showHostCursorInVideo = "agentDesk.showHostCursorInVideo"
        static let domMirrorEnabled = "agentDesk.domMirrorEnabled"
        static let agentSayVoiceLanguage = "agentDesk.agentSayVoiceLanguage"
        static let agentSayVoiceIdentifier = "agentDesk.agentSayVoiceIdentifier"
    }

    // iOS HIG / QuickType bar standard is 44pt; key chiclets at 36pt
    // leave 4pt of breathing room top and bottom. Match that so the
    // accessory row reads as part of the system keyboard, not a stranger.
    static let defaultAccessoryContainerHeight: Double = 44
    static let defaultAccessoryKeyHeight: Double = 36
    static let defaultAccessoryKeySpacing: Double = 6

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

    // ADR-0006: Spaces preview strip. Default on; a daily-driver agent
    // surface wants the at-a-glance thumbnails available immediately.
    // Users who don't want the phone to mirror non-active-Space contents
    // can flip it off in settings. PairingViewController reads this on
    // input-channel open and on settings change, sends a ClientConfig
    // frame, and mounts / unmounts the strip.
    var showSpacePreviews: Bool {
        get { defaults.object(forKey: Key.showSpacePreviews) as? Bool ?? true }
        set {
            defaults.set(newValue, forKey: Key.showSpacePreviews)
            postChange()
        }
    }

    // Crisp text overlay preference. Sent to the host in ClientConfig (wire key "ce"); the
    // host composes it with its own gate so this only turns the overlay off, never forces it
    // on when the host disabled it. Default on -- the sharp-text overlay is the good default.
    var crispTextOverlayEnabled: Bool {
        get { defaults.object(forKey: Key.crispTextOverlayEnabled) as? Bool ?? true }
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

    // ADR-0038 DOM mirror. Default off (opt-in beta). Gates whether the client opens the .dom lane
    // and shows the replay surface; the host still gates with its own flag. An env override
    // (`AGENTDESK_DOM_MIRROR_ENABLED=1`) wins, so a physical-device run can enable it via the
    // devicectl `--environment-variables` path (devicectl apps get env, not argv). Otherwise
    // bool(forKey:), so the sim launch arg (`-agentDesk.domMirrorEnabled YES`, the NSUserDefaults
    // argument domain) also works.
    var domMirrorEnabled: Bool {
        get {
            if let env = ProcessInfo.processInfo.environment["AGENTDESK_DOM_MIRROR_ENABLED"] {
                return env == "1" || env.lowercased() == "true"
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
}
