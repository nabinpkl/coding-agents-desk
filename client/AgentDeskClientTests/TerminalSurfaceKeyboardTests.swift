import Testing
import UIKit
import PtyTerminalWebView

@MainActor
struct TerminalSurfaceKeyboardTests {
    @Test
    func standaloneTerminalOwnsNativeKeyboardProxyAndAccessory() {
        let surface = TerminalSurface()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        controller.view.addSubview(surface)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        #expect(surface.terminalContent.inputMode == .nativeProxy)
        #expect(surface.terminalKeyboardSurface.keyboardDelegate === surface)
        #expect(surface.terminalKeyboardSurface.superview === surface)
        #expect(surface.terminalKeyboardSurface.alpha > 0)
        #expect(surface.terminalKeyboardSurface.alpha < 0.1)

        surface.setViewportPresented(true)
        surface.ptyTerminalContentDidRequestInputFocus(surface.terminalContent)
        #expect(surface.terminalKeyboardSurface.isFirstResponder)

        let accessory = surface.terminalKeyboardSurface.inputAccessoryView
        #expect(accessory is KeyboardAccessoryView)
        let dismiss = findButton(label: "Hide keyboard", in: accessory)
        #expect(dismiss != nil)
        dismiss?.sendActions(for: .touchUpInside)
        #expect(!surface.terminalKeyboardSurface.isFirstResponder)
    }

    private func findButton(label: String, in view: UIView?) -> UIButton? {
        guard let view else { return nil }
        if let button = view as? UIButton, button.accessibilityLabel == label {
            return button
        }
        return view.subviews.lazy.compactMap {
            findButton(label: label, in: $0)
        }.first
    }
}
