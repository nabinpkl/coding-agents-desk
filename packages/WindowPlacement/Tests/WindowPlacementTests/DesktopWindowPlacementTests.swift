import CoreGraphics
import Foundation
import Testing
import WindowPlacement

@Test func placementRoundTripsWithDesktopAndFrameTogether() throws {
    let placement = DesktopWindowPlacement(
        desktop: DesktopWindowAssignment(spaceID: 42, displayID: "display-2", ordinal: 0),
        frame: CGRect(x: 2_000, y: 100, width: 1_180, height: 760)
    )

    let data = try JSONEncoder().encode(placement)

    #expect(try JSONDecoder().decode(DesktopWindowPlacement.self, from: data) == placement)
    #expect(placement.isValid)
    #expect(!DesktopWindowPlacement(
        desktop: placement.desktop,
        frame: CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 100)
    ).isValid)
}
