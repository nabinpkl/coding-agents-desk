import AgentDeskWire

// View-only enforcement for a window capture target, host side.
//
// Enforced here rather than by hiding client chrome because the hazard is real, not
// cosmetic: `InputDispatcher` posts global `CGEvent`s in DISPLAY coordinates and has no
// per-window routing, so a live trackpad while the viewer is watching one window means
// blind clicking on a display they cannot see. Keyboard has the same problem one step
// removed: keys go to whatever the Mac has focused, which need not be the watched window.
//
// Space navigation is deliberately still allowed. The Spaces strip sits directly above the
// window picker and its tiles promise to switch the Mac's Desktop; that promise does not
// depend on display coordinates and does not touch the watched window. The window picker's
// own taps only retarget the view, which never reaches this gate at all.
enum WindowCaptureInputGate {
    static func allowsWhileWatchingWindow(_ input: NormalizedInput) -> Bool {
        switch input {
        case .switchSpaceGesture, .switchSpaceStep:
            return true
        // Listed rather than defaulted so a new input case has to make this choice explicitly
        // instead of silently defaulting into the permissive half.
        case .cursorSet, .cursorMove, .click, .scroll, .dragStart, .dragEnd,
             .systemCommand, .key, .modifierArm:
            return false
        }
    }
}
