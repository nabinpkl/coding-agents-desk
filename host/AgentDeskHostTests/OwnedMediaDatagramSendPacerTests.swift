import XCTest
@testable import AgentDeskHost

final class OwnedMediaDatagramSendPacerTests: XCTestCase {
    func testEvenSplitIntoBursts() {
        let pacer = OwnedMediaDatagramSendPacer(burstPacketCount: 4, burstPauseUs: 200)
        XCTAssertEqual(pacer.bursts(packetCount: 8), [0..<4, 4..<8])
    }

    func testTrailingPartialBurst() {
        let pacer = OwnedMediaDatagramSendPacer(burstPacketCount: 4, burstPauseUs: 200)
        XCTAssertEqual(pacer.bursts(packetCount: 10), [0..<4, 4..<8, 8..<10])
    }

    func testSinglePacketIsOneBurst() {
        let pacer = OwnedMediaDatagramSendPacer(burstPacketCount: 16, burstPauseUs: 200)
        XCTAssertEqual(pacer.bursts(packetCount: 1), [0..<1])
    }

    func testEmptyPacketSetYieldsNoBursts() {
        let pacer = OwnedMediaDatagramSendPacer(burstPacketCount: 16, burstPauseUs: 200)
        XCTAssertEqual(pacer.bursts(packetCount: 0), [])
    }

    func testNonPositiveBurstSizeDisablesPacing() {
        let pacer = OwnedMediaDatagramSendPacer(burstPacketCount: 0, burstPauseUs: 200)
        XCTAssertEqual(pacer.bursts(packetCount: 174), [0..<174])
    }

    func testPauseNanosConvertsMicrosToNanos() {
        XCTAssertEqual(OwnedMediaDatagramSendPacer(burstPacketCount: 16, burstPauseUs: 200).pauseNanos, 200_000)
        XCTAssertEqual(OwnedMediaDatagramSendPacer(burstPacketCount: 16, burstPauseUs: 0).pauseNanos, 0)
    }
}
