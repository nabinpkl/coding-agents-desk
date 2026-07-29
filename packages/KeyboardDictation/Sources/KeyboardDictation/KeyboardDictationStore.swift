import Foundation

public struct KeyboardDictationStore: Sendable {
    private enum FileName: String {
        case handoff = "handoff.json"
        case service = "service.json"
        case command = "command.json"
        case preferences = "preferences.json"
        case consumption = "consumption.json"
        case draft = "draft.json"
    }

    public let directoryURL: URL

    public init(appGroupIdentifier: String) throws {
        guard let root = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else {
            throw KeyboardDictationStoreError.unavailableAppGroup(
                appGroupIdentifier
            )
        }
        try self.init(
            directoryURL: root.appendingPathComponent(
                "KeyboardDictation",
                isDirectory: true
            )
        )
    }

    public init(directoryURL: URL) throws {
        self.directoryURL = directoryURL
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
    }

    @discardableResult
    public func prepareHandoff(
        id: UUID = UUID(),
        createdAt: Date = Date()
    ) throws -> KeyboardDictationHandoffRequest {
        let request = KeyboardDictationHandoffRequest(
            id: id,
            createdAt: createdAt
        )
        try write(request, to: .handoff, name: "handoff request")
        return request
    }

    public func pendingHandoff() throws -> KeyboardDictationHandoffRequest? {
        try read(
            KeyboardDictationHandoffRequest.self,
            from: .handoff,
            name: "handoff request"
        )
    }

    @discardableResult
    public func consumeHandoff(
        requestID: UUID
    ) throws -> KeyboardDictationHandoffRequest {
        guard let request = try pendingHandoff(), request.id == requestID else {
            throw KeyboardDictationStoreError.unexpectedHandoffRequest
        }
        try remove(.handoff)
        return request
    }

    public func serviceSnapshot() throws -> KeyboardDictationServiceSnapshot {
        let snapshot = try read(
            KeyboardDictationServiceSnapshot.self,
            from: .service,
            name: "service state"
        ) ?? .inactive
        guard snapshot.schemaVersion == KeyboardDictationContract.schemaVersion,
              snapshot.meterLevel.isFinite,
              (0...1).contains(snapshot.meterLevel)
        else {
            throw KeyboardDictationStoreError.invalidStoredValue(
                "service state"
            )
        }
        try validateText(snapshot.partialTranscript, name: "partial transcript")
        try validateText(snapshot.finalTranscript, name: "final transcript")
        try validateError(snapshot.errorMessage)
        return snapshot
    }

    public func saveServiceSnapshot(
        _ snapshot: KeyboardDictationServiceSnapshot
    ) throws {
        guard snapshot.schemaVersion == KeyboardDictationContract.schemaVersion,
              snapshot.meterLevel.isFinite,
              (0...1).contains(snapshot.meterLevel)
        else {
            throw KeyboardDictationStoreError.invalidStoredValue(
                "service state"
            )
        }
        try validateText(snapshot.partialTranscript, name: "partial transcript")
        try validateText(snapshot.finalTranscript, name: "final transcript")
        try validateError(snapshot.errorMessage)
        try write(snapshot, to: .service, name: "service state")
    }

    public func pendingCommand() throws -> KeyboardDictationCommand? {
        let command = try read(
            KeyboardDictationCommand.self,
            from: .command,
            name: "command"
        )
        guard command?.schemaVersion
            == KeyboardDictationContract.schemaVersion || command == nil
        else {
            throw KeyboardDictationStoreError.invalidStoredValue("command")
        }
        return command
    }

    public func saveCommand(_ command: KeyboardDictationCommand) throws {
        guard command.schemaVersion
            == KeyboardDictationContract.schemaVersion
        else {
            throw KeyboardDictationStoreError.invalidStoredValue("command")
        }
        try write(command, to: .command, name: "command")
    }

    public func clearCommand(ifMatching commandID: UUID) throws {
        guard try pendingCommand()?.id == commandID else { return }
        try remove(.command)
    }

    public func preferences() throws -> KeyboardDictationPreferences {
        let preferences = try read(
            KeyboardDictationPreferences.self,
            from: .preferences,
            name: "preferences"
        ) ?? KeyboardDictationPreferences()
        guard preferences.schemaVersion
            == KeyboardDictationContract.schemaVersion
        else {
            throw KeyboardDictationStoreError.invalidStoredValue("preferences")
        }
        return preferences
    }

    public func savePreferences(
        _ preferences: KeyboardDictationPreferences
    ) throws {
        guard preferences.schemaVersion
            == KeyboardDictationContract.schemaVersion
        else {
            throw KeyboardDictationStoreError.invalidStoredValue("preferences")
        }
        try write(preferences, to: .preferences, name: "preferences")
    }

    public func consumptionLog() throws -> KeyboardDictationConsumptionLog {
        let log = try read(
            KeyboardDictationConsumptionLog.self,
            from: .consumption,
            name: "consumption log"
        ) ?? KeyboardDictationConsumptionLog()
        guard log.schemaVersion == KeyboardDictationContract.schemaVersion else {
            throw KeyboardDictationStoreError.invalidStoredValue(
                "consumption log"
            )
        }
        return log
    }

    public func saveConsumptionLog(
        _ log: KeyboardDictationConsumptionLog
    ) throws {
        guard log.schemaVersion == KeyboardDictationContract.schemaVersion else {
            throw KeyboardDictationStoreError.invalidStoredValue(
                "consumption log"
            )
        }
        try write(log, to: .consumption, name: "consumption log")
    }

    public func draft() throws -> KeyboardDictationDraft? {
        let draft = try read(
            KeyboardDictationDraft.self,
            from: .draft,
            name: "draft"
        )
        guard draft?.schemaVersion
            == KeyboardDictationContract.schemaVersion || draft == nil
        else {
            throw KeyboardDictationStoreError.invalidStoredValue("draft")
        }
        try validateText(draft?.text, name: "draft")
        return draft
    }

    public func saveDraft(_ draft: KeyboardDictationDraft) throws {
        guard draft.schemaVersion == KeyboardDictationContract.schemaVersion else {
            throw KeyboardDictationStoreError.invalidStoredValue("draft")
        }
        try validateText(draft.text, name: "draft")
        try write(draft, to: .draft, name: "draft")
    }

    public func clearDraft() throws {
        try remove(.draft)
    }

    public func purgeExpiredResult(now: Date = Date()) throws {
        let snapshot = try serviceSnapshot()
        guard snapshot.phase == .completed,
              now.timeIntervalSince(snapshot.updatedAt)
                > KeyboardDictationContract.resultLifetime
        else {
            return
        }
        try saveServiceSnapshot(KeyboardDictationServiceSnapshot(
            generationID: snapshot.generationID,
            phase: .ready,
            acknowledgedCommandID: snapshot.acknowledgedCommandID,
            updatedAt: now
        ))
        try clearDraft()
    }

    private func url(for file: FileName) -> URL {
        directoryURL.appendingPathComponent(file.rawValue)
    }

    private func read<Value: Decodable>(
        _ type: Value.Type,
        from file: FileName,
        name: String
    ) throws -> Value? {
        let fileURL = url(for: file)
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return nil
        }
        do {
            let values = try fileURL.resourceValues(forKeys: [.fileSizeKey])
            guard (values.fileSize ?? 0)
                <= KeyboardDictationContract.maximumStoreFileBytes
            else {
                throw KeyboardDictationStoreError.valueTooLarge(name)
            }
            let data = try Data(contentsOf: fileURL, options: [.mappedIfSafe])
            return try JSONDecoder.keyboardDictation.decode(type, from: data)
        } catch let error as KeyboardDictationStoreError {
            throw error
        } catch {
            throw KeyboardDictationStoreError.invalidStoredValue(name)
        }
    }

    private func write<Value: Encodable>(
        _ value: Value,
        to file: FileName,
        name: String
    ) throws {
        let data = try JSONEncoder.keyboardDictation.encode(value)
        guard data.count <= KeyboardDictationContract.maximumStoreFileBytes else {
            throw KeyboardDictationStoreError.valueTooLarge(name)
        }
        try data.write(to: url(for: file), options: [.atomic])
    }

    private func remove(_ file: FileName) throws {
        let fileURL = url(for: file)
        do {
            try FileManager.default.removeItem(at: fileURL)
        } catch let error as NSError
            where error.domain == NSCocoaErrorDomain
                && error.code == NSFileNoSuchFileError
        {
            // An App Group peer can clear a file after it was observed but
            // before this removal. Clearing is idempotent; every other
            // filesystem failure still propagates.
            return
        }
    }

    private func validateText(_ value: String?, name: String) throws {
        guard let value else { return }
        guard value.utf8.count
            <= KeyboardDictationContract.maximumTranscriptUTF8Bytes
        else {
            throw KeyboardDictationStoreError.valueTooLarge(name)
        }
    }

    private func validateError(_ value: String?) throws {
        guard let value else { return }
        guard value.utf8.count
            <= KeyboardDictationContract.maximumErrorUTF8Bytes
        else {
            throw KeyboardDictationStoreError.valueTooLarge("error message")
        }
    }
}

private extension JSONEncoder {
    static var keyboardDictation: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

private extension JSONDecoder {
    static var keyboardDictation: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
}
