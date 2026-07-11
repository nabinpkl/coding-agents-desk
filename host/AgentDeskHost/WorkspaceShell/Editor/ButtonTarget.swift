import AppKit

/// Obj-C target trampoline so a plain closure can drive an `NSButton`'s target/action.
/// Holds the closure weakly to the owner via the caller's capture list.
final class ButtonTarget: NSObject {
    private let action: () -> Void

    init(_ action: @escaping () -> Void) {
        self.action = action
    }

    @objc func fire() {
        action()
    }
}
