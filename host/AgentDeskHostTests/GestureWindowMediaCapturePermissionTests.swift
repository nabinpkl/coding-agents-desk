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
}
