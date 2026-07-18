import Foundation

public enum AgentRawEventLimits {
    public static let maximumRecordBytes = 100 * 1024 * 1024
    public static let sourceFragmentBytes = 2 * 1024 * 1024
    public static let maximumConcurrentTransfers = 4
    public static let transferTimeout: TimeInterval = 30
}

public struct AgentRawEventRequest: Codable, Equatable, Sendable {
    public let type = "agent-raw-event-get"
    public let requestId: String
    public let sessionId: String
    public let eventIndex: Int

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sessionId = "sid"
        case eventIndex = "ei"
    }

    public init(requestId: String, sessionId: String, eventIndex: Int) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.eventIndex = eventIndex
    }
}

public struct AgentRawEventResponse: Codable, Equatable, Sendable {
    public let type = "agent-raw-event"
    public let requestId: String
    public let sessionId: String
    public let eventIndex: Int
    public let text: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sessionId = "sid"
        case eventIndex = "ei"
        case text = "tx"
    }

    public init(requestId: String, sessionId: String, eventIndex: Int, text: String) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.eventIndex = eventIndex
        self.text = text
    }
}

public struct AgentRawEventPart: Codable, Equatable, Sendable {
    public let type = "agent-raw-event-part"
    public let transferId: String
    public let requestId: String
    public let sessionId: String
    public let eventIndex: Int
    public let partIndex: Int
    public let partCount: Int
    public let totalByteCount: Int
    public let data: Data

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case transferId = "xid"
        case requestId = "rid"
        case sessionId = "sid"
        case eventIndex = "ei"
        case partIndex = "pi"
        case partCount = "pc"
        case totalByteCount = "nb"
        case data = "d"
    }

    public init(
        transferId: String,
        requestId: String,
        sessionId: String,
        eventIndex: Int,
        partIndex: Int,
        partCount: Int,
        totalByteCount: Int,
        data: Data
    ) {
        self.transferId = transferId
        self.requestId = requestId
        self.sessionId = sessionId
        self.eventIndex = eventIndex
        self.partIndex = partIndex
        self.partCount = partCount
        self.totalByteCount = totalByteCount
        self.data = data
    }
}

public struct AgentRawEventError: Codable, Equatable, Sendable {
    public let type = "agent-raw-event-error"
    public let requestId: String
    public let sessionId: String
    public let eventIndex: Int
    public let reason: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sessionId = "sid"
        case eventIndex = "ei"
        case reason = "r"
    }

    public init(requestId: String, sessionId: String, eventIndex: Int, reason: String) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.eventIndex = eventIndex
        self.reason = reason
    }
}

public enum AgentRawEventFragmenter {
    public static func makeParts(
        data: Data,
        requestId: String,
        sessionId: String,
        eventIndex: Int,
        transferId: String = UUID().uuidString
    ) throws -> [AgentRawEventPart] {
        var parts: [AgentRawEventPart] = []
        try forEachPart(
            data: data,
            requestId: requestId,
            sessionId: sessionId,
            eventIndex: eventIndex,
            transferId: transferId
        ) { parts.append($0) }
        return parts
    }

    public static func forEachPart(
        data: Data,
        requestId: String,
        sessionId: String,
        eventIndex: Int,
        transferId: String = UUID().uuidString,
        _ body: (AgentRawEventPart) throws -> Void
    ) throws {
        guard data.count <= AgentRawEventLimits.maximumRecordBytes else {
            throw AgentRawEventTransferError.oversized
        }
        let partCount = max(1, Int(ceil(Double(data.count) / Double(AgentRawEventLimits.sourceFragmentBytes))))
        for partIndex in 0..<partCount {
            let start = partIndex * AgentRawEventLimits.sourceFragmentBytes
            let end = min(data.count, start + AgentRawEventLimits.sourceFragmentBytes)
            try body(AgentRawEventPart(
                transferId: transferId,
                requestId: requestId,
                sessionId: sessionId,
                eventIndex: eventIndex,
                partIndex: partIndex,
                partCount: partCount,
                totalByteCount: data.count,
                data: data.subdata(in: start..<end)
            ))
        }
    }
}

public enum AgentRawEventTransferError: Error, Equatable, Sendable {
    case invalidPart
    case duplicatePart
    case inconsistentTransfer
    case oversized
    case tooManyTransfers
    case invalidText
}

public struct AgentRawEventReassembler: Sendable {
    public enum Outcome: Equatable, Sendable {
        case pending
        case complete(AgentRawEventResponse)
        case rejected(AgentRawEventError, AgentRawEventTransferError)
    }

    private struct Transfer: Sendable {
        let requestId: String
        let sessionId: String
        let eventIndex: Int
        let partCount: Int
        let totalByteCount: Int
        let createdAt: Date
        var receivedParts: Set<Int>
        var buffer: Data
    }

    private var transfers: [String: Transfer] = [:]

    public init() {}

    public func containsTransfer(_ transferId: String) -> Bool {
        transfers[transferId] != nil
    }

    public mutating func accept(_ part: AgentRawEventPart, now: Date = Date()) -> Outcome {
        let error = AgentRawEventError(
            requestId: part.requestId,
            sessionId: part.sessionId,
            eventIndex: part.eventIndex,
            reason: "raw event transfer rejected"
        )
        guard part.partCount > 0,
              part.partIndex >= 0,
              part.partIndex < part.partCount,
              part.totalByteCount >= 0,
              part.totalByteCount <= AgentRawEventLimits.maximumRecordBytes,
              part.data.count <= AgentRawEventLimits.sourceFragmentBytes else {
            transfers.removeValue(forKey: part.transferId)
            return .rejected(error, part.totalByteCount > AgentRawEventLimits.maximumRecordBytes ? .oversized : .invalidPart)
        }
        let expectedPartCount = max(
            1,
            Int(ceil(Double(part.totalByteCount) / Double(AgentRawEventLimits.sourceFragmentBytes)))
        )
        let partStart = part.partIndex * AgentRawEventLimits.sourceFragmentBytes
        let expectedPartByteCount = max(
            0,
            min(AgentRawEventLimits.sourceFragmentBytes, part.totalByteCount - partStart)
        )
        guard part.partCount == expectedPartCount,
              part.data.count == expectedPartByteCount else {
            transfers.removeValue(forKey: part.transferId)
            return .rejected(error, .invalidPart)
        }

        var transfer: Transfer
        if let current = transfers[part.transferId] {
            guard current.requestId == part.requestId,
                  current.sessionId == part.sessionId,
                  current.eventIndex == part.eventIndex,
                  current.partCount == part.partCount,
                  current.totalByteCount == part.totalByteCount else {
                transfers.removeValue(forKey: part.transferId)
                return .rejected(error, .inconsistentTransfer)
            }
            guard !current.receivedParts.contains(part.partIndex) else {
                transfers.removeValue(forKey: part.transferId)
                return .rejected(error, .duplicatePart)
            }
            transfer = current
        } else {
            guard transfers.count < AgentRawEventLimits.maximumConcurrentTransfers else {
                return .rejected(error, .tooManyTransfers)
            }
            transfer = Transfer(
                requestId: part.requestId,
                sessionId: part.sessionId,
                eventIndex: part.eventIndex,
                partCount: part.partCount,
                totalByteCount: part.totalByteCount,
                createdAt: now,
                receivedParts: [],
                buffer: Data(count: part.totalByteCount)
            )
        }
        transfer.receivedParts.insert(part.partIndex)
        transfer.buffer.replaceSubrange(
            partStart..<(partStart + part.data.count),
            with: part.data
        )
        transfers[part.transferId] = transfer
        guard transfer.receivedParts.count == transfer.partCount else { return .pending }
        transfers.removeValue(forKey: part.transferId)
        guard transfer.buffer.count == transfer.totalByteCount else {
            return .rejected(error, .inconsistentTransfer)
        }
        guard let text = String(data: transfer.buffer, encoding: .utf8) else {
            return .rejected(error, .invalidText)
        }
        return .complete(AgentRawEventResponse(
            requestId: transfer.requestId,
            sessionId: transfer.sessionId,
            eventIndex: transfer.eventIndex,
            text: text
        ))
    }

    public mutating func expire(now: Date = Date()) -> [AgentRawEventError] {
        let expired = transfers.filter {
            now.timeIntervalSince($0.value.createdAt) >= AgentRawEventLimits.transferTimeout
        }
        for id in expired.keys { transfers.removeValue(forKey: id) }
        return expired.values.map {
            AgentRawEventError(
                requestId: $0.requestId,
                sessionId: $0.sessionId,
                eventIndex: $0.eventIndex,
                reason: "raw event transfer expired"
            )
        }
    }
}
