import Foundation
import Testing
@testable import AgentDeskWire

@Test func rawEventLabelAndSystemRoundTrip() throws {
    let event = ActivityEvent(
        index: 3,
        ts: 4,
        type: "system",
        blocks: [ActivityBlock(kind: "metadata", label: "Token Usage", text: "42")]
    )
    let decoded = try JSONDecoder().decode(ActivityEvent.self, from: JSONEncoder().encode(event))
    #expect(decoded == event)
}

@Test func rawEventFragmentRoundTripRejectsInvalidTransfers() throws {
    let text = String(repeating: "abc\n", count: 600_000)
    let parts = try AgentRawEventFragmenter.makeParts(
        data: Data(text.utf8),
        requestId: "r1",
        sessionId: "s1",
        eventIndex: 9,
        transferId: "x1"
    )
    #expect(parts.count > 1)
    var reassembler = AgentRawEventReassembler()
    for part in parts.dropLast() {
        #expect(reassembler.accept(part) == .pending)
    }
    #expect(reassembler.accept(parts.last!) == .complete(AgentRawEventResponse(
        requestId: "r1", sessionId: "s1", eventIndex: 9, text: text
    )))

    var duplicate = AgentRawEventReassembler()
    #expect(duplicate.accept(parts[0]) == .pending)
    guard case .rejected(_, .duplicatePart) = duplicate.accept(parts[0]) else {
        Issue.record("expected duplicate part rejection")
        return
    }
}

@Test func rawEventReassemblyExpiresIncompleteTransfer() throws {
    let start = Date(timeIntervalSince1970: 100)
    let part = try #require(AgentRawEventFragmenter.makeParts(
        data: Data(repeating: 1, count: AgentRawEventLimits.sourceFragmentBytes + 1),
        requestId: "r", sessionId: "s", eventIndex: 1, transferId: "x"
    ).first)
    var reassembler = AgentRawEventReassembler()
    #expect(reassembler.accept(part, now: start) == .pending)
    let errors = reassembler.expire(now: start.addingTimeInterval(31))
    #expect(errors.count == 1)
    #expect(errors[0].reason.contains("expired"))
}

@Test func rawEventReassemblyRejectsInconsistentAndOversizedTransfers() throws {
    let parts = try AgentRawEventFragmenter.makeParts(
        data: Data(repeating: 1, count: AgentRawEventLimits.sourceFragmentBytes + 1),
        requestId: "r", sessionId: "s", eventIndex: 1, transferId: "x"
    )
    var inconsistent = AgentRawEventReassembler()
    #expect(inconsistent.accept(parts[0]) == .pending)
    let mismatched = AgentRawEventPart(
        transferId: parts[1].transferId,
        requestId: parts[1].requestId,
        sessionId: "different-session",
        eventIndex: parts[1].eventIndex,
        partIndex: parts[1].partIndex,
        partCount: parts[1].partCount,
        totalByteCount: parts[1].totalByteCount,
        data: parts[1].data
    )
    guard case .rejected(_, .inconsistentTransfer) = inconsistent.accept(mismatched) else {
        Issue.record("expected inconsistent transfer rejection")
        return
    }

    let oversized = AgentRawEventPart(
        transferId: "oversized",
        requestId: "r",
        sessionId: "s",
        eventIndex: 1,
        partIndex: 0,
        partCount: 1,
        totalByteCount: AgentRawEventLimits.maximumRecordBytes + 1,
        data: Data()
    )
    var sizeChecked = AgentRawEventReassembler()
    guard case .rejected(_, .oversized) = sizeChecked.accept(oversized) else {
        Issue.record("expected oversized transfer rejection")
        return
    }
}

@Test func rawEventReassemblyLimitsConcurrentTransfers() throws {
    let data = Data(repeating: 1, count: AgentRawEventLimits.sourceFragmentBytes + 1)
    let firstParts = try (0...AgentRawEventLimits.maximumConcurrentTransfers).map { index in
        try #require(AgentRawEventFragmenter.makeParts(
            data: data,
            requestId: "r\(index)",
            sessionId: "s",
            eventIndex: index,
            transferId: "x\(index)"
        ).first)
    }
    var reassembler = AgentRawEventReassembler()
    for part in firstParts.prefix(AgentRawEventLimits.maximumConcurrentTransfers) {
        #expect(reassembler.accept(part) == .pending)
    }
    guard case .rejected(_, .tooManyTransfers) = reassembler.accept(firstParts.last!) else {
        Issue.record("expected concurrent transfer limit rejection")
        return
    }
}

@Test func rawEventReassemblySupportsExactMaximumRecordSize() throws {
    let source = Data(repeating: 0x61, count: AgentRawEventLimits.maximumRecordBytes)
    var reassembler = AgentRawEventReassembler()
    var outcome: AgentRawEventReassembler.Outcome = .pending
    try AgentRawEventFragmenter.forEachPart(
        data: source,
        requestId: "boundary",
        sessionId: "session",
        eventIndex: 100,
        transferId: "boundary-transfer"
    ) { part in
        outcome = reassembler.accept(part)
    }
    guard case .complete(let response) = outcome else {
        Issue.record("expected 100 MiB transfer to complete")
        return
    }
    #expect(response.text.utf8.count == AgentRawEventLimits.maximumRecordBytes)
    #expect(response.text.first == "a")
    #expect(response.text.last == "a")
}
