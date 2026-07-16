import Testing
import UIKit

@testable import AgentDeskClient

@MainActor
struct CursorPointerViewTests {
    @Test func fallbackCursorUsesGreyGhostPresentation() {
        let view = CursorPointerView()

        view.setPresentation(.ghost)

        #expect(view.presentation == .ghost)
        #expect(view.ghostVisualIsActive)
    }

    @Test func mirroredCursorKeepsGhostPresentationAcrossImageChanges() {
        let view = CursorPointerView()
        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 12)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 12))
        }
        view.setPresentation(.ghost)

        view.apply(image: image, renderSize: CGSize(width: 8, height: 12))

        #expect(view.presentation == .ghost)
        #expect(view.ghostVisualIsActive)
    }

    @Test func confirmedPresentationRestoresMirroredCursor() {
        let view = CursorPointerView()
        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 12)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 12))
        }
        view.apply(image: image, renderSize: CGSize(width: 8, height: 12))
        view.setPresentation(.ghost)

        view.setPresentation(.confirmed)

        #expect(view.presentation == .confirmed)
        #expect(!view.ghostVisualIsActive)
    }
}
