import Testing
import UIKit
import PtyTerminalWebView
import WebKit

@MainActor
struct TerminalSurfaceKeyboardTests {
    @Test
    func nativeProxyDisablesTheXtermTextareaResponder() async throws {
        let surface = TerminalSurface()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        controller.view.addSubview(surface)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        let disabled = try await waitForJavaScriptBoolean(
            in: surface.terminalContent.webView,
            expression: """
            (() => {
              const textarea = document.querySelector('.xterm-helper-textarea');
              return textarea ? textarea.disabled : null;
            })()
            """
        )

        #expect(disabled)
    }

    @Test
    func webInputRetainsTheXtermTextareaResponder() async throws {
        let content = PtyTerminalWebView(profile: .singleSession, inputMode: .web)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        controller.view.addSubview(content)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        let enabled = try await waitForJavaScriptBoolean(
            in: content.webView,
            expression: """
            (() => {
              const textarea = document.querySelector('.xterm-helper-textarea');
              return textarea ? !textarea.disabled : null;
            })()
            """
        )

        #expect(enabled)
    }

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

    private func waitForJavaScriptBoolean(
        in webView: WKWebView,
        expression: String
    ) async throws -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(10))
        while clock.now < deadline {
            if let value = try? await webView.evaluateJavaScript(expression),
               let boolean = value as? Bool {
                return boolean
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        Issue.record("terminal web runtime did not expose its input textarea")
        return false
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
