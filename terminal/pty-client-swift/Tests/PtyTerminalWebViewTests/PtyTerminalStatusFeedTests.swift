import XCTest
@testable import PtyTerminalWebView

/// The two status directions have to stay disjoint.
///
/// `feedStatus` announces to the owner AND draws; `feedLocalStatus` only draws. When the
/// drawing half also announced, an owner that drew what it was told -- which the standalone
/// PTY manager window did -- recursed until the stack guard page killed the host
/// (2026-08-20, EXC_BAD_ACCESS in `swift_dynamicCast`, ~40 frames of
/// didReceiveStatus -> feedLocalStatus -> feedStatus).
///
/// An owner that still echoes now terminates, but draws the line twice -- once for the
/// status itself and once because it asked. That is the honest result of asking to render
/// something already rendering, so it is left alone rather than suppressed with reentrancy
/// state; no delegate in this repo echoes.
@MainActor
final class PtyTerminalStatusFeedTests: XCTestCase {
    /// Stands in for the window that crashed: it renders whatever status it is handed.
    private final class EchoingDelegate: PtyTerminalWebViewDelegate {
        private(set) var announced: [String] = []

        func ptyTerminalContent(_ content: PtyTerminalWebView, didReceiveStatus text: String) {
            announced.append(text)
            content.feedLocalStatus(Data(text.utf8))
        }
    }

    private func viewWithSlot() throws -> (PtyTerminalWebView, String) {
        let view = PtyTerminalWebView(profile: .workspace)
        view.webView.stopLoading()
        let pane = try XCTUnwrap(view.workspaceState.selectedPane)
        view.slots[pane.terminalID] = PtyTerminalWebView.Slot(
            paneID: pane.paneID,
            terminalID: pane.terminalID,
            owner: view
        )
        return (view, pane.terminalID)
    }

    private func statusTexts(_ view: PtyTerminalWebView) -> [String] {
        view.deliveryQueue.deliveries.compactMap { delivery in
            guard let data = delivery.json.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["type"] as? String == "status" else { return nil }
            return object["text"] as? String
        }
    }

    /// The crash, as directly as it can be expressed: an owner that draws what it is told,
    /// told something. Reaching the assertions at all is most of the test.
    func testAnEchoingOwnerDoesNotRecurse() throws {
        let (view, terminalID) = try viewWithSlot()
        defer { view.teardown() }
        let delegate = EchoingDelegate()
        view.delegate = delegate
        view.deliveryQueue.removeAll()

        view.feedStatus("session attached", terminalID: terminalID)

        XCTAssertEqual(delegate.announced, ["session attached"], "announced once, not once per bounce")
    }

    /// Host-authored text still reaches the screen; it just no longer claims to have been
    /// received from the runtime.
    func testFeedLocalStatusDrawsWithoutAnnouncing() throws {
        let (view, _) = try viewWithSlot()
        defer { view.teardown() }
        let delegate = EchoingDelegate()
        view.delegate = delegate
        view.deliveryQueue.removeAll()

        view.feedLocalStatus(Data("[renderer unavailable]".utf8))

        XCTAssertEqual(statusTexts(view), ["[renderer unavailable]"])
        XCTAssertTrue(delegate.announced.isEmpty, "drawing is not receiving")
    }

    /// Runtime status is still announced to owners that only observe it.
    func testRuntimeStatusIsStillAnnounced() throws {
        final class ObservingDelegate: PtyTerminalWebViewDelegate {
            private(set) var announced: [String] = []
            func ptyTerminalContent(_ content: PtyTerminalWebView, didReceiveStatus text: String) {
                announced.append(text)
            }
        }
        let (view, terminalID) = try viewWithSlot()
        defer { view.teardown() }
        let delegate = ObservingDelegate()
        view.delegate = delegate
        view.deliveryQueue.removeAll()

        view.feedStatus("exit 0", terminalID: terminalID)

        XCTAssertEqual(delegate.announced, ["exit 0"])
        XCTAssertEqual(statusTexts(view), ["exit 0"])
    }
}
