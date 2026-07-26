import XCTest
@testable import AgentDeskClient

final class OwnedMediaLatestFramePacerTests: XCTestCase {
    func testReplacesPendingFrameAndDecodesItsDependency() {
        var pacer = OwnedMediaLatestFramePacer<Int>(expectedFrameRate: 1)

        XCTAssertEqual(pacer.submit(1, nowNs: 0), [.display(1)])
        XCTAssertEqual(pacer.submit(2, nowNs: 100_000_000), [])
        XCTAssertEqual(pacer.submit(3, nowNs: 200_000_000), [.decodeOnly(2)])
        XCTAssertEqual(pacer.nextPresentationDeadlineNs, 1_000_000_000)
        XCTAssertNil(pacer.takePendingIfDue(nowNs: 999_999_999))
        XCTAssertEqual(pacer.takePendingIfDue(nowNs: 1_000_000_000), .display(3))
        XCTAssertNil(pacer.nextPresentationDeadlineNs)
    }

    func testDisplaysNewestArrivalWhenPendingFrameIsOverdue() {
        var pacer = OwnedMediaLatestFramePacer<Int>(expectedFrameRate: 1)

        XCTAssertEqual(pacer.submit(1, nowNs: 0), [.display(1)])
        XCTAssertEqual(pacer.submit(2, nowNs: 100_000_000), [])
        XCTAssertEqual(
            pacer.submit(3, nowNs: 1_000_000_000),
            [.decodeOnly(2), .display(3)]
        )
        XCTAssertNil(pacer.nextPresentationDeadlineNs)
    }
}
