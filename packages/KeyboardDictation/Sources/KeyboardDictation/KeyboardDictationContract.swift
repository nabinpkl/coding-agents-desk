import Foundation

public enum KeyboardDictationContract {
    public static let schemaVersion = 1
    public static let appGroupInfoKey = "AgentDeskKeyboardAppGroup"
    public static let handoffURLScheme = "agentdesk"
    public static let handoffURLHost = "keyboard-dictation"
    public static let handoffRequestQueryItem = "request"
    public static let maximumTranscriptUTF8Bytes = 64 * 1024
    public static let maximumErrorUTF8Bytes = 8 * 1024
    public static let maximumStoreFileBytes = 128 * 1024
    public static let resultLifetime: TimeInterval = 24 * 60 * 60

    public static func appGroupIdentifier(in bundle: Bundle = .main) throws -> String {
        guard let identifier = bundle.object(
            forInfoDictionaryKey: appGroupInfoKey
        ) as? String,
              !identifier.isEmpty
        else {
            throw KeyboardDictationStoreError.missingAppGroupIdentifier
        }
        return identifier
    }

    public static func handoffURL(requestID: UUID) -> URL {
        var components = URLComponents()
        components.scheme = handoffURLScheme
        components.host = handoffURLHost
        components.queryItems = [
            URLQueryItem(
                name: handoffRequestQueryItem,
                value: requestID.uuidString
            )
        ]
        guard let url = components.url else {
            preconditionFailure("Keyboard dictation URL must be representable")
        }
        return url
    }

    public static func requestID(from url: URL) -> UUID? {
        guard url.scheme?.lowercased() == handoffURLScheme,
              url.host?.lowercased() == handoffURLHost,
              let components = URLComponents(
                url: url,
                resolvingAgainstBaseURL: false
              ),
              let rawRequest = components.queryItems?.first(where: {
                  $0.name == handoffRequestQueryItem
              })?.value
        else {
            return nil
        }
        return UUID(uuidString: rawRequest)
    }
}

public enum KeyboardDictationStoreError: Error, Equatable, LocalizedError {
    case missingAppGroupIdentifier
    case unavailableAppGroup(String)
    case invalidStoredValue(String)
    case unexpectedHandoffRequest
    case valueTooLarge(String)

    public var errorDescription: String? {
        switch self {
        case .missingAppGroupIdentifier:
            "The keyboard App Group is not configured."
        case .unavailableAppGroup:
            "The keyboard App Group is unavailable."
        case .invalidStoredValue(let name):
            "The saved keyboard \(name) is invalid."
        case .unexpectedHandoffRequest:
            "This keyboard request is no longer pending."
        case .valueTooLarge(let name):
            "The keyboard \(name) exceeded its safety limit."
        }
    }
}

public struct KeyboardDictationHandoffRequest: Codable, Equatable, Sendable {
    public let id: UUID
    public let createdAt: Date

    public init(id: UUID = UUID(), createdAt: Date = Date()) {
        self.id = id
        self.createdAt = createdAt
    }
}

public enum KeyboardDictationServicePhase: String, Codable, Equatable, Sendable {
    case inactive
    case arming
    case ready
    case recording
    case saving
    case transcribing
    case analyzing
    case completed
    case failed
}

public struct KeyboardDictationServiceSnapshot: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let generationID: UUID?
    public let phase: KeyboardDictationServicePhase
    public let captureSessionID: UUID?
    public let acknowledgedCommandID: UUID?
    public let partialTranscript: String?
    public let finalTranscript: String?
    public let recordingID: String?
    public let meterLevel: Float
    public let errorMessage: String?
    public let updatedAt: Date

    public init(
        schemaVersion: Int = KeyboardDictationContract.schemaVersion,
        generationID: UUID?,
        phase: KeyboardDictationServicePhase,
        captureSessionID: UUID? = nil,
        acknowledgedCommandID: UUID? = nil,
        partialTranscript: String? = nil,
        finalTranscript: String? = nil,
        recordingID: String? = nil,
        meterLevel: Float = 0,
        errorMessage: String? = nil,
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.generationID = generationID
        self.phase = phase
        self.captureSessionID = captureSessionID
        self.acknowledgedCommandID = acknowledgedCommandID
        self.partialTranscript = partialTranscript
        self.finalTranscript = finalTranscript
        self.recordingID = recordingID
        self.meterLevel = meterLevel
        self.errorMessage = errorMessage
        self.updatedAt = updatedAt
    }

    public static let inactive = KeyboardDictationServiceSnapshot(
        generationID: nil,
        phase: .inactive
    )

    public var isArmed: Bool {
        generationID != nil && phase != .inactive
    }

    public func acknowledging(
        _ commandID: UUID,
        phase replacementPhase: KeyboardDictationServicePhase? = nil,
        updatedAt: Date = Date()
    ) -> KeyboardDictationServiceSnapshot {
        KeyboardDictationServiceSnapshot(
            generationID: generationID,
            phase: replacementPhase ?? phase,
            captureSessionID: captureSessionID,
            acknowledgedCommandID: commandID,
            partialTranscript: partialTranscript,
            finalTranscript: finalTranscript,
            recordingID: recordingID,
            meterLevel: meterLevel,
            errorMessage: errorMessage,
            updatedAt: updatedAt
        )
    }
}

public enum KeyboardDictationCommandKind: String, Codable, Equatable, Sendable {
    case ping
    case start
    case stop
    case dismissResult
    case turnOff
}

public struct KeyboardDictationCommand: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: UUID
    public let generationID: UUID
    public let kind: KeyboardDictationCommandKind
    public let createdAt: Date

    public init(
        schemaVersion: Int = KeyboardDictationContract.schemaVersion,
        id: UUID = UUID(),
        generationID: UUID,
        kind: KeyboardDictationCommandKind,
        createdAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.generationID = generationID
        self.kind = kind
        self.createdAt = createdAt
    }
}

public enum KeyboardDictationInsertionMode: String, Codable, Equatable, Sendable {
    case automatic
    case explicitReview
}

public struct KeyboardDictationPreferences: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public var insertionMode: KeyboardDictationInsertionMode

    public init(
        schemaVersion: Int = KeyboardDictationContract.schemaVersion,
        insertionMode: KeyboardDictationInsertionMode = .automatic
    ) {
        self.schemaVersion = schemaVersion
        self.insertionMode = insertionMode
    }
}

public struct KeyboardDictationConsumption: Codable, Equatable, Sendable {
    public let recordingID: String
    public let consumedAt: Date

    public init(recordingID: String, consumedAt: Date = Date()) {
        self.recordingID = recordingID
        self.consumedAt = consumedAt
    }
}

public struct KeyboardDictationConsumptionLog: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public private(set) var entries: [KeyboardDictationConsumption]

    public init(
        schemaVersion: Int = KeyboardDictationContract.schemaVersion,
        entries: [KeyboardDictationConsumption] = []
    ) {
        self.schemaVersion = schemaVersion
        self.entries = Array(entries.suffix(32))
    }

    public func contains(recordingID: String) -> Bool {
        entries.contains { $0.recordingID == recordingID }
    }

    public mutating func record(
        recordingID: String,
        consumedAt: Date = Date()
    ) {
        entries.removeAll { $0.recordingID == recordingID }
        entries.append(KeyboardDictationConsumption(
            recordingID: recordingID,
            consumedAt: consumedAt
        ))
        entries = Array(entries.suffix(32))
    }
}

public struct KeyboardDictationDraft: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let recordingID: String
    public var text: String
    public let updatedAt: Date

    public init(
        schemaVersion: Int = KeyboardDictationContract.schemaVersion,
        recordingID: String,
        text: String,
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.recordingID = recordingID
        self.text = text
        self.updatedAt = updatedAt
    }
}

public struct KeyboardDocumentContextFingerprint: Equatable, Sendable {
    public let beforeInput: String?
    public let afterInput: String?
    public let selectedText: String?

    public init(
        beforeInput: String?,
        afterInput: String?,
        selectedText: String?
    ) {
        self.beforeInput = beforeInput.map { String($0.suffix(128)) }
        self.afterInput = afterInput.map { String($0.prefix(128)) }
        self.selectedText = selectedText.map { String($0.prefix(128)) }
    }
}
