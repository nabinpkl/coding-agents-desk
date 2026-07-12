import AppKit
import Testing
import WebKit

@testable import AgentDeskHost

// R24 accessibility verification. Rather than a screenshot (blocked by the shell-context TCC screen
// capture grant), these assert the Agents window and its content surface through the AppKit
// accessibility API — the same identifiers an AX/Maestro driver or VoiceOver would resolve. The
// window is AX-identified as `agentdesk-agents-window`; its content surface carries either the live
// webview's `agents-webview` id or, if the bundled panel assets fail to resolve, the fallback's
// `agents-unavailable` id — so the surface is always AX-reachable.
@MainActor
struct AgentWindowControllerTests {
    /// Collects the non-empty accessibility identifiers of a view subtree.
    private func axIdentifiers(in view: NSView?) -> Set<String> {
        guard let view else { return [] }
        var result: Set<String> = []
        let identifier = view.accessibilityIdentifier()
        if !identifier.isEmpty { result.insert(identifier) }
        for subview in view.subviews {
            result.formUnion(axIdentifiers(in: subview))
        }
        return result
    }

    @Test func showBuildsAnAccessibilityIdentifiedAgentsWindow() throws {
        let controller = AgentWindowController(sidecarClient: FakeSidecarClient())
        controller.show()

        let window = try #require(controller.windowForTesting)
        #expect(window.title == "Agents")
        #expect(window.identifier?.rawValue == AgentWindowController.windowIdentifier)
        #expect(window.accessibilityIdentifier() == AgentWindowController.windowIdentifier)

        // The content surface is AX-reachable as either the live webview or the fallback label.
        let ids = axIdentifiers(in: window.contentView)
        #expect(
            ids.contains(AgentWindowController.webViewAccessibilityIdentifier)
            || ids.contains(AgentWindowController.unavailableAccessibilityIdentifier)
        )
    }

    @Test func toggleReusesTheSameWindowRatherThanRebuilding() throws {
        let controller = AgentWindowController(sidecarClient: FakeSidecarClient())
        controller.show()
        let first = try #require(controller.windowForTesting)

        // A toggle hides-or-shows but must never construct a second window: the surface (and its
        // in-flight feed) is preserved across visibility changes.
        controller.toggle()
        controller.toggle()
        #expect(controller.windowForTesting === first)
    }

    @Test func stopTearsDownTheWindow() {
        let controller = AgentWindowController(sidecarClient: FakeSidecarClient())
        controller.show()
        #expect(controller.windowForTesting != nil)

        controller.stop()
        #expect(controller.windowForTesting == nil)
    }
}
