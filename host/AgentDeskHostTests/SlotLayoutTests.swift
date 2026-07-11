import CoreGraphics
import XCTest

final class SlotLayoutTests: XCTestCase {
    func testBarsSpanTheirEdgesAndSlotIsFullScreen() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let layout = computeSlotLayout(screen: screen, config: SlotLayoutConfig(sidebarWidth: 240, topBarHeight: 38))

        // Sidebar: left edge, full height. Top bar: top edge, full width.
        XCTAssertEqual(layout.sidebar, CGRect(x: 0, y: 0, width: 240, height: 900))
        XCTAssertEqual(layout.topBar, CGRect(x: 0, y: 862, width: 1440, height: 38))
        XCTAssertEqual(layout.dockEnrichment, CGRect(x: 12, y: 16, width: 1416, height: 188))
        // Slot is the whole screen; the bars float over it when revealed.
        XCTAssertEqual(layout.slot, screen)
    }

    func testDockEnrichmentUsesBottomVisibleFrameAndDoesNotInsetSlot() {
        let screen = CGRect(x: 0, y: 80, width: 1440, height: 820)
        let layout = computeSlotLayout(
            screen: screen,
            config: SlotLayoutConfig(
                sidebarWidth: 240,
                topBarHeight: 38,
                dockEnrichmentHeight: 160,
                dockEnrichmentHorizontalInset: 24,
                dockEnrichmentBottomOffset: 12
            )
        )

        XCTAssertEqual(layout.dockEnrichment, CGRect(x: 24, y: 92, width: 1392, height: 160))
        XCTAssertEqual(layout.slot, screen)
    }

    func testDockEnrichmentCanReserveAutoHiddenDockInset() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let layout = computeSlotLayout(
            screen: screen,
            config: SlotLayoutConfig(
                dockEnrichmentHeight: 160,
                dockEnrichmentBottomOffset: 65
            )
        )

        XCTAssertEqual(layout.dockEnrichment, CGRect(x: 12, y: 65, width: 1416, height: 160))
        XCTAssertEqual(layout.slot, screen)
    }

    func testPinnedSidebarInsetsSlotFromTheLeft() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let layout = computeSlotLayout(
            screen: screen, config: SlotLayoutConfig(sidebarWidth: 240, topBarHeight: 38),
            sidebarPinned: true, topBarPinned: false
        )
        // Bar frames are unchanged; only the slot insets by the sidebar width.
        XCTAssertEqual(layout.sidebar, CGRect(x: 0, y: 0, width: 240, height: 900))
        XCTAssertEqual(layout.slot, CGRect(x: 240, y: 0, width: 1200, height: 900))
    }

    func testCustomSidebarWidthDrivesSidebarAndPinnedSlot() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let layout = computeSlotLayout(
            screen: screen, config: SlotLayoutConfig(sidebarWidth: 360, topBarHeight: 38),
            sidebarPinned: true, topBarPinned: false
        )

        XCTAssertEqual(layout.sidebar, CGRect(x: 0, y: 0, width: 360, height: 900))
        XCTAssertEqual(layout.slot, CGRect(x: 360, y: 0, width: 1080, height: 900))
    }

    func testPinnedTopBarInsetsSlotFromTheTop() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let layout = computeSlotLayout(
            screen: screen, config: SlotLayoutConfig(sidebarWidth: 240, topBarHeight: 38),
            sidebarPinned: false, topBarPinned: true
        )
        // Origin is bottom-left, so the top bar eats height (not origin.y).
        XCTAssertEqual(layout.slot, CGRect(x: 0, y: 0, width: 1440, height: 862))
    }

    func testBothPinnedInsetsSlotFromLeftAndTop() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let layout = computeSlotLayout(
            screen: screen, config: SlotLayoutConfig(sidebarWidth: 240, topBarHeight: 38),
            sidebarPinned: true, topBarPinned: true
        )
        XCTAssertEqual(layout.slot, CGRect(x: 240, y: 0, width: 1200, height: 862))
    }

    func testUnpinnedSlotMatchesFullScreenDefault() {
        let screen = CGRect(x: 100, y: 50, width: 1280, height: 800)
        let pinnedFalse = computeSlotLayout(screen: screen, sidebarPinned: false, topBarPinned: false)
        let defaulted = computeSlotLayout(screen: screen)
        XCTAssertEqual(pinnedFalse.slot, screen)
        XCTAssertEqual(pinnedFalse.slot, defaulted.slot)
    }

    func testRespectsNonZeroOrigin() {
        // Second monitor: screen origin offset to the right.
        let screen = CGRect(x: 1440, y: 0, width: 1280, height: 800)
        let layout = computeSlotLayout(screen: screen, config: SlotLayoutConfig(sidebarWidth: 200, topBarHeight: 40))

        XCTAssertEqual(layout.sidebar, CGRect(x: 1440, y: 0, width: 200, height: 800))
        XCTAssertEqual(layout.topBar, CGRect(x: 1440, y: 760, width: 1280, height: 40))
        XCTAssertEqual(layout.slot, screen)
    }

    func testCenteredRectPlacesFixedSizeAtCenter() {
        let outer = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let inner = centeredRect(in: outer, size: CGSize(width: 500, height: 400))
        XCTAssertEqual(inner, CGRect(x: 250, y: 200, width: 500, height: 400))
        XCTAssertEqual(inner.midX, outer.midX)
        XCTAssertEqual(inner.midY, outer.midY)
    }

    func testCenteredRectRespectsOffsetOrigin() {
        let outer = CGRect(x: 100, y: 50, width: 600, height: 400)
        let inner = centeredRect(in: outer, size: CGSize(width: 300, height: 200))
        XCTAssertEqual(inner.midX, outer.midX)
        XCTAssertEqual(inner.midY, outer.midY)
        XCTAssertEqual(inner.width, 300)
        XCTAssertEqual(inner.height, 200)
    }

    func testClampsOnTinyScreenWithoutNegativeRects() {
        let screen = CGRect(x: 0, y: 0, width: 100, height: 20)
        let layout = computeSlotLayout(screen: screen, config: SlotLayoutConfig(sidebarWidth: 240, topBarHeight: 38))

        XCTAssertLessThanOrEqual(layout.sidebar.width, screen.width)
        XCTAssertLessThanOrEqual(layout.topBar.height, screen.height)
        XCTAssertLessThanOrEqual(layout.dockEnrichment.height, screen.height)
        XCTAssertLessThanOrEqual(layout.dockEnrichment.width, screen.width)
        XCTAssertGreaterThanOrEqual(layout.sidebar.width, 0)
        XCTAssertGreaterThanOrEqual(layout.topBar.height, 0)
        XCTAssertGreaterThanOrEqual(layout.dockEnrichment.height, 0)
        XCTAssertGreaterThanOrEqual(layout.dockEnrichment.width, 0)
    }
}
