import CoreGraphics
import Testing
import UIKit

@MainActor
struct PairingViewControllerRetargetTests {
    @Test func manualSinkViewportPanStoresPendingRetarget() {
        let controller = makeController()
        let scroll = makeScrollView()
        controller.sinkScrollView = scroll

        controller.scrollViewWillBeginDragging(scroll)
        controller.scrollViewDidEndDragging(scroll, willDecelerate: false)

        #expect(controller.pendingCursorRetarget?.displayId == "display-a")
        #expect(controller.pendingCursorRetarget?.sourcePoint == CGPoint(x: 1000, y: 500))
        #expect(controller.pendingCursorRetarget?.hostPoint == CGPoint(x: 1100, y: 700))
    }

    @Test func manualSinkViewportPanStoresRetargetAfterDeceleration() {
        let controller = makeController()
        let scroll = makeScrollView()
        controller.sinkScrollView = scroll

        controller.scrollViewWillBeginDragging(scroll)
        controller.scrollViewDidEndDragging(scroll, willDecelerate: true)
        #expect(controller.pendingCursorRetarget == nil)

        controller.scrollViewDidEndDecelerating(scroll)

        #expect(controller.pendingCursorRetarget?.sourcePoint == CGPoint(x: 1000, y: 500))
    }

    @Test func programmaticEdgeFollowDoesNotStorePendingRetarget() {
        let controller = makeController()
        let scroll = makeScrollView()
        controller.sinkScrollView = scroll

        controller.finishManualViewportPan(scroll)

        #expect(controller.pendingCursorRetarget == nil)
    }

    @Test func displayChangeClearsPendingRetarget() {
        let controller = makeController()
        controller.pendingCursorRetarget = CursorViewportRetarget(
            displayId: "display-a",
            sourcePoint: CGPoint(x: 100, y: 200),
            hostPoint: CGPoint(x: 300, y: 400)
        )

        controller.applyDesktopStateForCursorModel(DesktopState(
            displays: [
                DisplayMetadata(
                    id: "display-b",
                    originX: 0,
                    originY: 0,
                    widthPoints: 1200,
                    heightPoints: 800
                )
            ],
            spaces: [],
            activeDisplayId: "display-b",
            selectedDisplayId: "display-b",
            activeSpaceId: nil,
            cursorX: nil,
            cursorY: nil
        ))

        #expect(controller.pendingCursorRetarget == nil)
    }

    private func makeController() -> PairingViewController {
        let controller = PairingViewController()
        controller.activeDisplayRect = CGRect(x: 0, y: 0, width: 2000, height: 1000)
        controller.activeDisplayIdMirror = "display-a"
        controller.lastDesktopState = DesktopState(
            displays: [
                DisplayMetadata(
                    id: "display-a",
                    originX: 100,
                    originY: 200,
                    widthPoints: 2000,
                    heightPoints: 1000
                )
            ],
            spaces: [],
            activeDisplayId: "display-a",
            selectedDisplayId: "display-a",
            activeSpaceId: nil,
            cursorX: nil,
            cursorY: nil
        )
        return controller
    }

    private func makeScrollView() -> UIScrollView {
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: 500, height: 500))
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 4
        scroll.zoomScale = 2
        scroll.contentOffset = CGPoint(x: 250, y: 250)
        return scroll
    }
}
