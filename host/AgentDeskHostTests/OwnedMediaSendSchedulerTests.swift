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

final class OwnedMediaSendSchedulerTests: XCTestCase {
    /// A budget so far above any test payload that `waitNanos` is always zero, so ordering
    /// tests are about ordering and nothing else. Pacing itself is covered by
    /// LinkSendPacerTests, plus the one timing test at the bottom of this file.
    private func unpacedScheduler(
        sendPacket: @escaping OwnedMediaSendScheduler.PacketSender
    ) -> OwnedMediaSendScheduler {
        OwnedMediaSendScheduler(
            pacer: LinkSendPacer(bytesPerSecond: 1_000_000_000, burstBytes: 1_000_000),
            sendPacket: sendPacket
        )
    }

    // Repair and live alternate packet by packet while both are waiting. Repair is requested
    // exactly when the link is already failing, so it must neither be starved by live video nor
    // allowed to displace it.
    func testRepairInterleavesWithLivePacketByPacket() async {
        let recorder = BlockingPacketRecorder(blockedValue: 2)
        let scheduler = unpacedScheduler { packet in
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
        XCTAssertEqual(values, [1, 2, 9, 3, 10, 4])
    }

    func testRepairCannotStarveLiveVideo() async {
        let recorder = BlockingPacketRecorder(blockedValue: 1)
        let scheduler = unpacedScheduler { packet in
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

    // The live continuation resumes only once the frame's last packet is gone. The encode drain
    // awaits this, so resuming early would let the next capture encode while the previous frame
    // was still on the wire -- reopening the queue this exists to close.
    func testLiveSendCompletesOnlyAfterEveryPacket() async {
        let recorder = BlockingPacketRecorder(blockedValue: 0)
        let scheduler = unpacedScheduler { packet in
            await recorder.send(packet)
        }
        let sent = await scheduler.sendLive([1, 2, 3].map { Data([$0]) })
        XCTAssertTrue(sent)
        let values = await recorder.recordedValues()
        XCTAssertEqual(values, [1, 2, 3])
    }

    func testEmptyLiveSendSucceedsWithoutTouchingTheWire() async {
        let recorder = BlockingPacketRecorder(blockedValue: 0)
        let scheduler = unpacedScheduler { packet in
            await recorder.send(packet)
        }
        let sent = await scheduler.sendLive([])
        XCTAssertTrue(sent)
        let values = await recorder.recordedValues()
        XCTAssertTrue(values.isEmpty)
    }

    // A carrier failure fails the frame rather than hanging it. The encode drain is awaiting
    // this continuation, so a dropped resume stalls video permanently.
    func testCarrierFailureFailsThePendingLiveFrame() async {
        let scheduler = unpacedScheduler { _ in false }
        let sent = await scheduler.sendLive([Data([1]), Data([2])])
        XCTAssertFalse(sent)
    }

    // The scheduler actually consults the pacer. Lower bound only, with a wide margin: the
    // claim is "this was paced at all", and an upper bound would just measure the CI machine.
    //
    // 4 packets of 1000 bytes at 2000 B/s with a 1000-byte bucket owes ~1.5s of waiting. A
    // scheduler that ignored its pacer would finish in microseconds.
    func testSchedulerPacesToTheBudget() async {
        let recorder = BlockingPacketRecorder(blockedValue: 0)
        let scheduler = OwnedMediaSendScheduler(
            pacer: LinkSendPacer(bytesPerSecond: 2_000, burstBytes: 1_000)
        ) { packet in
            await recorder.send(packet)
        }
        let packet = Data(repeating: 7, count: 1_000)
        let startedAt = DispatchTime.now().uptimeNanoseconds
        let sent = await scheduler.sendLive(Array(repeating: packet, count: 4))
        let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000

        XCTAssertTrue(sent)
        XCTAssertGreaterThan(elapsedMs, 500)
    }
}
