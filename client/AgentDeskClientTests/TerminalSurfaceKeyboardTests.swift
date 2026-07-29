import Testing
import UIKit
import PtyTerminalWebView
import WebKit

// Every test owns a key window and a cold WKWebView. Keep those lifecycles
// sequential so one test cannot hide another's window or contend with its
// terminal WebContent launch.
@MainActor
@Suite(.serialized)
struct TerminalSurfaceKeyboardTests {
    @Test
    func nativeProxyRequestsKeyboardAfterTapRelease() async throws {
        let surface = TerminalSurface()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        controller.view.addSubview(surface)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        surface.setViewportPresented(true)

        _ = try await waitForJavaScriptBoolean(
            in: surface.terminalContent.webView,
            expression: "document.querySelector('.terminal-pane') ? true : null"
        )
        try await surface.terminalContent.webView.evaluateJavaScript(
            """
            (() => {
              const pane = document.querySelector('.terminal-pane');
              pane.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true,
                pointerType: 'touch'
              }));
            })()
            """
        )
        try await Task.sleep(for: .milliseconds(100))
        #expect(!surface.terminalKeyboardSurface.isFirstResponder)

        try await surface.terminalContent.webView.evaluateJavaScript(
            """
            (() => {
              const pane = document.querySelector('.terminal-pane');
              pane.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true,
                pointerType: 'touch'
              }));
              pane.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            })()
            """
        )
        let becameFirstResponder = await waitForCondition {
            surface.terminalKeyboardSurface.isFirstResponder
        }
        #expect(becameFirstResponder)
    }

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
        let deadline = clock.now.advanced(by: .seconds(30))
        var lastEvaluationError: Error?
        while clock.now < deadline {
            do {
                if let value = try await webView.evaluateJavaScript(expression),
                   let boolean = value as? Bool {
                    return boolean
                }
            } catch {
                lastEvaluationError = error
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        let errorDescription = String(describing: lastEvaluationError)
        Issue.record(
            "terminal web runtime did not expose its input textarea; last JavaScript error: \(errorDescription)"
        )
        return false
    }

    private func waitForCondition(_ condition: () -> Bool) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while clock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
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
