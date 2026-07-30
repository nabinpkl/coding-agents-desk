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
    func nativeProxyRequestsKeyboardAfterXtermTouchTap() async throws {
        let surface = TerminalSurface()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        controller.view.addSubview(surface)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        surface.setViewportPresented(true)

        // Required, not incidental: every step below dispatches on the pane, so a missing one has to
        // fail here rather than as a null-dereference inside the next evaluateJavaScript.
        try #require(await waitForJavaScriptBoolean(
            in: surface.terminalContent.webView,
            expression: "document.querySelector('.terminal-pane') ? true : null"
        ))
        try await surface.terminalContent.webView.evaluateJavaScript(
            """
            (() => {
              const pane = document.querySelector('.terminal-pane');
              pane.dispatchEvent(new CustomEvent('-xterm-gesturechange'));
            })()
            """
        )
        // A settle window, not a wait for something: the assertion is that a gesturechange produces
        // NO focus request, and absence has no arrival to subscribe to. Making it deterministic would
        // need an ordered flush message through the same bridge (a later message proving the earlier
        // one was delivered and consumed), which the terminal protocol does not expose. Left as a
        // bounded settle; if the surface ever focuses on gesturechange, the assertion below catches
        // it as long as this window covers ordinary delivery.
        try await Task.sleep(for: .milliseconds(100))
        #expect(!surface.terminalKeyboardSurface.isFirstResponder)

        try await surface.terminalContent.webView.evaluateJavaScript(
            """
            (() => {
              const pane = document.querySelector('.terminal-pane');
              pane.dispatchEvent(new CustomEvent('-xterm-gesturetap'));
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

    /// Polls the page until `expression` answers a boolean rather than null.
    ///
    /// This one cannot be event-driven from the test side, and the attempt is worth recording so it
    /// is not retried: moving the wait into the page as a `MutationObserver` promise awaited through
    /// `callAsyncJavaScript` fails with "Completion handler for function call is no longer reachable",
    /// because the terminal runtime reloads its page during boot and a reload destroys any pending
    /// in-page promise. Swallowing the error and asking again across page generations, which is what
    /// this loop does, is therefore the mechanism rather than a shortcut.
    ///
    /// The deadline is a failure bound, not a pace. It was 30s and still expired once, on a machine
    /// running four simulator suites at once; 60s keeps that bound clear of ordinary load without
    /// affecting the healthy path, where the answer arrives in a few hundred milliseconds.
    ///
    /// `expression` must answer `true`/`false` once its subject exists and `null` until then, which
    /// is what distinguishes "not rendered yet" from "rendered, and the answer is false".
    private func waitForJavaScriptBoolean(
        in webView: WKWebView,
        expression: String,
        timeout: Duration = .seconds(60)
    ) async throws -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        var lastEvaluationError: Error?
        while clock.now < deadline {
            do {
                if let value = try await webView.evaluateJavaScript(expression),
                   let boolean = value as? Bool {
                    return boolean
                }
            } catch {
                // Expected across a boot-time reload: the frame that owned the evaluation went away.
                lastEvaluationError = error
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        let lastError = String(describing: lastEvaluationError)
        Issue.record(
            "terminal web runtime did not settle \(expression) within \(timeout); last JavaScript error: \(lastError)"
        )
        return false
    }

    /// Polls, deliberately: this waits on state a WKScriptMessage sets after crossing from the web
    /// content process, and no amount of yielding on this side advances another process. Sleeping is
    /// the only way to let that delivery happen, so the budget here is a failure bound rather than a
    /// pace, and it is generous for that reason. At 2s it was tight enough to be a load bet.
    private func waitForCondition(
        timeout: Duration = .seconds(30),
        _ condition: () -> Bool
    ) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
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
