import XCTest
@testable import AgentDeskHost

private actor BlockingPacketRecorder {
    private let blockedValue: UInt8
    private var values: [UInt8] = []
    private var isBlocked = false
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(blockedValue: UInt8) {
        self.blockedValue = blockedValue
    }

    func send(_ packet: Data) async -> Bool {
        guard let value = packet.first else { return false }
        values.append(value)
        if value == blockedValue {
            isBlocked = true
            await withCheckedContinuation { continuation in
                releaseContinuation = continuation
            }
        }
        return true
    }

    func waitUntilBlocked() async {
        while !isBlocked {
            await Task.yield()
        }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }

    func recordedValues() -> [UInt8] {
        values
    }
}

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

    func testRepairBurstRunsBeforeNextLiveBurst() async {
        let recorder = BlockingPacketRecorder(blockedValue: 2)
        let scheduler = OwnedMediaDatagramBurstScheduler(
            pacer: OwnedMediaDatagramSendPacer(burstPacketCount: 2, burstPauseUs: 0)
        ) { packet in
            await recorder.send(packet)
        }
        let live = Task {
            await scheduler.sendLive([1, 2, 3, 4].map { Data([$0]) })
        }
        await recorder.waitUntilBlocked()
        await scheduler.enqueueRepair([Data([9]), Data([10])])
        await recorder.release()

        let sent = await live.value
        let values = await recorder.recordedValues()
        XCTAssertTrue(sent)
        XCTAssertEqual(values, [1, 2, 9, 10, 3, 4])
    }

    func testRepairBurstsCannotStarveLiveVideo() async {
        let recorder = BlockingPacketRecorder(blockedValue: 1)
        let scheduler = OwnedMediaDatagramBurstScheduler(
            pacer: OwnedMediaDatagramSendPacer(burstPacketCount: 1, burstPauseUs: 0)
        ) { packet in
            await recorder.send(packet)
        }
        let live = Task {
            await scheduler.sendLive([Data([1]), Data([2])])
        }
        await recorder.waitUntilBlocked()
        await scheduler.enqueueRepair([Data([9]), Data([10])])
        await recorder.release()

        let sent = await live.value
        let values = await recorder.recordedValues()
        XCTAssertTrue(sent)
        XCTAssertEqual(values, [1, 9, 2, 10])
    }
}
