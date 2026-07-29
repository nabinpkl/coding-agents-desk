import UIKit

@MainActor
protocol KeyboardFeedbackProviding: AnyObject {
    func keyActivated(hapticsEnabled: Bool)
    func deleteRepeated()
    func cursorMoved(hapticsEnabled: Bool)
}

@MainActor
final class SystemKeyboardFeedbackEngine: KeyboardFeedbackProviding {
    private lazy var impact = UIImpactFeedbackGenerator(style: .light)
    private lazy var selection = UISelectionFeedbackGenerator()

    func keyActivated(hapticsEnabled: Bool) {
        UIDevice.current.playInputClick()
        if hapticsEnabled {
            impact.impactOccurred()
            impact.prepare()
        }
    }

    func deleteRepeated() {
        UIDevice.current.playInputClick()
    }

    func cursorMoved(hapticsEnabled: Bool) {
        guard hapticsEnabled else { return }
        selection.selectionChanged()
        selection.prepare()
    }
}
