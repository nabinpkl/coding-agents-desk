import CoreGraphics
import XCTest
@testable import AgentDeskHost

final class SidebarWidthTests: XCTestCase {
    func testClampsToSupportedRange() {
        XCTAssertEqual(SidebarWidth.clamped(10), SidebarWidth.minimum)
        XCTAssertEqual(SidebarWidth.clamped(999), SidebarWidth.maximum)
        XCTAssertEqual(SidebarWidth.clamped(320), 320)
    }

    func testAlsoClampsToScreenWidth() {
        XCTAssertEqual(SidebarWidth.clamped(420, screenWidth: 300), 300)
        XCTAssertEqual(SidebarWidth.clamped(20, screenWidth: 100), 100)
    }
}
