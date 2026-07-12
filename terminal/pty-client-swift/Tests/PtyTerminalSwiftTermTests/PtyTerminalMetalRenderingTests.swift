import PtyTerminalSwiftTerm
import XCTest

final class PtyTerminalMetalRenderingTests: XCTestCase {
    func testDisabledByDefault() {
        XCTAssertEqual(PtyTerminalMetalRendering.from(environment: [:]), .disabled)
    }

    func testLegacyEnvironmentEnablesDefaultBuffering() {
        XCTAssertEqual(
            PtyTerminalMetalRendering.from(environment: [
                PtyTerminalMetalRendering.enabledEnvironmentKey: "true",
            ]),
            .enabled(bufferingMode: .perRowPersistent)
        )
    }

    func testPortableEnvironmentOverridesLegacyEnvironment() {
        XCTAssertEqual(
            PtyTerminalMetalRendering.from(environment: [
                PtyTerminalMetalRendering.enabledEnvironmentKey: "false",
                PtyTerminalMetalRendering.portableEnabledEnvironmentKey: "1",
                PtyTerminalMetalRendering.portableBufferingEnvironmentKey: "perFrameAggregated",
            ]),
            .enabled(bufferingMode: .perFrameAggregated)
        )
    }

    func testUnknownBufferingFallsBackToPerRowPersistent() {
        XCTAssertEqual(
            PtyTerminalMetalRendering.from(environment: [
                PtyTerminalMetalRendering.enabledEnvironmentKey: "yes",
                PtyTerminalMetalRendering.bufferingEnvironmentKey: "unknown",
            ]),
            .enabled(bufferingMode: .perRowPersistent)
        )
    }
}
