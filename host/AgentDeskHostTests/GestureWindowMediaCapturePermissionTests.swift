import AppKit
import Testing
import WebKit

@testable import AgentDeskHost

struct GestureWindowMediaCapturePermissionTests {
    @Test func bundledInteractionOriginMayCaptureExpectedMedia() {
        for type in [
            WKMediaCaptureType.camera,
            .microphone,
            .cameraAndMicrophone,
        ] {
            #expect(
                GestureWindowController.mediaCaptureDecision(
                    originProtocol: "interactionfeed",
                    originHost: "app",
                    type: type
                ) == .grant
            )
        }
    }

    @Test func anyOtherOriginIsDenied() {
        #expect(
            GestureWindowController.mediaCaptureDecision(
                originProtocol: "https",
                originHost: "app",
                type: .microphone
            ) == .deny
        )
        #expect(
            GestureWindowController.mediaCaptureDecision(
                originProtocol: "interactionfeed",
                originHost: "example.invalid",
                type: .cameraAndMicrophone
            ) == .deny
        )
    }

    @MainActor
    @Test func gestureAndVoicePanelAnswersTheSharedZoomChords() throws {
        let controller = GestureWindowController(onSpaceStep: { _ in })
        controller.showVoice()
        let window = try #require(controller.windowForTesting)
        window.concealFromTheDesktopUnderTest()
        let contentView = try #require(window.contentView as? PanelWindowContentView)

        #expect(contentView.performKeyEquivalent(with: keyEvent("=")))
        #expect(controller.zoomScaleForTesting == 1.1)
        #expect(try #require(controller.webViewZoomScaleForTesting) == 1.1)
        #expect(contentView.performKeyEquivalent(with: keyEvent("-")))
        #expect(contentView.performKeyEquivalent(with: keyEvent("-")))
        #expect(controller.zoomScaleForTesting == 0.9)
        #expect(try #require(controller.webViewZoomScaleForTesting) == 0.9)
        #expect(contentView.performKeyEquivalent(with: keyEvent("0")))
        #expect(controller.zoomScaleForTesting == 1)
        #expect(try #require(controller.webViewZoomScaleForTesting) == 1)

        controller.stop()
    }

    @MainActor
    private func keyEvent(_ characters: String) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: .command,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: 0
        )!
    }
}
