import AppKit

enum AgentWindowZoomCommand: Equatable {
    case zoomIn
    case zoomOut
    case reset
}

/// The Agents window's zoom level, as a clamped integer step rather than a free Double.
///
/// Steps keep the round trip exact: zooming in and back out lands on precisely 1.0, where
/// multiplying and dividing by a factor accumulates error and leaves the panel a fraction of a
/// percent off its own default. The range matches the one the Workspace IDE window already settled
/// on (`WorkspaceIDELocalState.zoomStepRange`) so the two windows do not disagree about how far
/// zoom goes.
struct AgentWindowZoom: Equatable {
    static let stepRange = -4...10

    private(set) var step: Int

    /// 0.6 through 2.0, in tenths.
    var scale: Double { Double(10 + step) / 10 }

    /// Clamps on the way in as well as on every change, so a step read back from an older store --
    /// or from a build whose range was wider -- cannot put the window at a size it cannot leave.
    init(step: Int = 0) {
        self.step = Self.clamp(step)
    }

    mutating func apply(_ command: AgentWindowZoomCommand) {
        switch command {
        case .zoomIn: step = Self.clamp(step + 1)
        case .zoomOut: step = Self.clamp(step - 1)
        case .reset: step = 0
        }
    }

    private static func clamp(_ value: Int) -> Int {
        min(max(value, stepRange.lowerBound), stepRange.upperBound)
    }
}

/// Command+minus / Command+equals / Command+zero, as a pure function over the event.
///
/// The host is `LSUIElement`, so there is no menu bar to hang these on and no `NSMenuItem` key
/// equivalent for AppKit to match: the window has to recognize them itself. The mapping is kept
/// apart from the view that calls it for the same reason `KeyboardActivation` is -- it is the part
/// worth testing, and testing it needs no window.
enum AgentWindowZoomShortcut {
    static func command(for event: NSEvent) -> AgentWindowZoomCommand? {
        guard event.type == .keyDown else { return nil }
        // Command and nothing else that carries meaning. Shift is deliberately not consulted, so the
        // chord most people think of as Command-plus counts; Option and Control are rejected, because
        // claiming Command+Option+minus would shadow a binding this window does not own.
        guard event.modifierFlags.intersection([.command, .option, .control]) == .command else {
            return nil
        }
        switch event.charactersIgnoringModifiers {
        // `charactersIgnoringModifiers` keeps Shift applied, so Command+Shift+equals arrives as "+"
        // and not as "=". Both spellings of each key are accepted for that reason.
        case "=", "+": return .zoomIn
        case "-", "_": return .zoomOut
        case "0": return .reset
        default: return nil
        }
    }
}
