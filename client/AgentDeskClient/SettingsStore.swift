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
    }

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

    private func postChange() {
        NotificationCenter.default.post(name: Self.changedNotification, object: self)
    }
}
