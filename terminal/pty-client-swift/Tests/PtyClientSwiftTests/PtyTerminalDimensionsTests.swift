import XCTest
@testable import PtyClientSwift

final class PtyTerminalDimensionsTests: XCTestCase {
    func testBootstrapDimensionsAreUsableBeforeRendererLayout() {
        XCTAssertEqual(
            PtyTerminalDimensions.bootstrap,
            PtyTerminalDimensions(columns: 80, rows: 24)
        )
    }
}
