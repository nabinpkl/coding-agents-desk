import CoreGraphics
import Foundation

// UserDefaults-backed store for trackpad / scroll feel preferences. The
// raw values are unitless multipliers (1.0 = default) so the UI can show
// them as "1.0x", "1.5x" sliders without translation. SettingsViewController
// writes here; GestureTranslator and PairingViewController read.
//
// Changes post a single notification so observers can refresh without
// having to wire individual KVO on each property. Observers re-read all
// fields on the notification — there are only four, so it's cheaper than
// tracking which one changed.
final class SettingsStore: @unchecked Sendable {
    static let shared = SettingsStore()

    static let changedNotification = Notification.Name("com.example.agentdesk.AgentDeskClient.settingsChanged")

    private let defaults = UserDefaults.standard

    private enum Key {
        static let cursorSpeed = "agentDesk.cursorSpeed"
        static let cursorAccel = "agentDesk.cursorAcceleration"
        static let scrollSpeed = "agentDesk.scrollSpeed"
        static let scrollInverted = "agentDesk.scrollInverted"
        static let accessoryContainerHeight = "agentDesk.accessoryContainerHeight"
        static let accessoryKeyHeight = "agentDesk.accessoryKeyHeight"
        static let accessoryKeySpacing = "agentDesk.accessoryKeySpacing"
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

    private func postChange() {
        NotificationCenter.default.post(name: Self.changedNotification, object: self)
    }
}
