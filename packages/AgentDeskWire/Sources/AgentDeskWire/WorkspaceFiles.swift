import Foundation

/// An opaque host-generated digest identifying one text file revision. Clients must return the
/// revision they read when requesting a write; the host owns digest generation and comparison.
public struct WorkspaceFileRevision: Codable, Equatable, Sendable {
    public let digest: String

    public init(digest: String) {
        self.digest = digest
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case digest = "d"
    }
}

/// A caller-generated opaque identifier used to correlate one Files request with its response.
/// It intentionally encodes as a single string so the envelope keeps `rid` compact.
public struct WorkspaceFileRequestID: Codable, Equatable, Sendable {
    public let value: String

    public init(value: String) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        value = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}

/// A workspace the host permits the authenticated client to browse. `id` is opaque to the client.
public struct WorkspaceSummary: Codable, Equatable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case id = "i"
        case name = "n"
    }
}

/// An immediate child of a workspace-relative directory. `path` is always workspace-relative.
public struct WorkspaceDirectoryEntry: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let isDirectory: Bool

    public init(name: String, path: String, isDirectory: Bool) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case name = "n"
        case path = "p"
        case isDirectory = "d"
    }
}

public struct WorkspaceListResult: Codable, Equatable, Sendable {
    public let workspaces: [WorkspaceSummary]

    public init(workspaces: [WorkspaceSummary]) {
        self.workspaces = workspaces
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case workspaces = "ws"
    }
}

public struct WorkspaceDirectoryListResult: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let path: String
    public let entries: [WorkspaceDirectoryEntry]

    public init(workspaceID: String, path: String, entries: [WorkspaceDirectoryEntry]) {
        self.workspaceID = workspaceID
        self.path = path
        self.entries = entries
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case workspaceID = "w"
        case path = "p"
        case entries = "e"
    }
}

/// A bounded UTF-8 file read. The host rejects binary, non-UTF-8, and oversized files instead of
/// emitting this result.
public struct WorkspaceFileReadResult: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let path: String
    public let text: String
    public let revision: WorkspaceFileRevision

    public init(workspaceID: String, path: String, text: String, revision: WorkspaceFileRevision) {
        self.workspaceID = workspaceID
        self.path = path
        self.text = text
        self.revision = revision
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case workspaceID = "w"
        case path = "p"
        case text = "x"
        case revision = "r"
    }
}

public struct WorkspaceFileWriteResult: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let path: String
    public let revision: WorkspaceFileRevision

    public init(workspaceID: String, path: String, revision: WorkspaceFileRevision) {
        self.workspaceID = workspaceID
        self.path = path
        self.revision = revision
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case workspaceID = "w"
        case path = "p"
        case revision = "r"
    }
}

public struct WorkspaceFileConflict: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let path: String
    public let currentRevision: WorkspaceFileRevision

    public init(workspaceID: String, path: String, currentRevision: WorkspaceFileRevision) {
        self.workspaceID = workspaceID
        self.path = path
        self.currentRevision = currentRevision
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case workspaceID = "w"
        case path = "p"
        case currentRevision = "r"
    }
}

public enum WorkspaceFileErrorCode: String, Codable, CaseIterable, Equatable, Sendable {
    case forbidden
    case invalidPath = "invalid-path"
    case notFound = "not-found"
    case notDirectory = "not-directory"
    case notFile = "not-file"
    case binary
    case invalidUTF8 = "invalid-utf8"
    case tooLarge = "too-large"
    case writeFailed = "write-failed"
}

public struct WorkspaceFileError: Codable, Equatable, Sendable {
    public let code: WorkspaceFileErrorCode
    public let workspaceID: String?
    public let path: String?
    public let message: String?

    public init(
        code: WorkspaceFileErrorCode,
        workspaceID: String? = nil,
        path: String? = nil,
        message: String? = nil
    ) {
        self.code = code
        self.workspaceID = workspaceID
        self.path = path
        self.message = message
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case code = "c"
        case workspaceID = "w"
        case path = "p"
        case message = "m"
    }
}

/// Requests sent by an authenticated Files client. All paths are workspace-relative strings;
/// containment and filesystem semantics remain exclusively host responsibilities.
public enum WorkspaceFileRequest: Codable, Equatable, Sendable {
    case listWorkspaces(requestID: WorkspaceFileRequestID)
    case listDirectory(requestID: WorkspaceFileRequestID, workspaceID: String, path: String)
    case read(requestID: WorkspaceFileRequestID, workspaceID: String, path: String)
    case write(
        requestID: WorkspaceFileRequestID,
        workspaceID: String,
        path: String,
        expectedRevision: WorkspaceFileRevision,
        text: String
    )

    /// The correlation id carried by every request, so a caller can build a matching error
    /// response even when it cannot otherwise interpret the request (e.g. the store is unavailable).
    public var requestID: WorkspaceFileRequestID {
        switch self {
        case .listWorkspaces(let requestID),
             .listDirectory(let requestID, _, _),
             .read(let requestID, _, _),
             .write(let requestID, _, _, _, _):
            requestID
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case workspaceID = "w"
        case path = "p"
        case expectedRevision = "r"
        case text = "x"
        case requestID = "rid"
    }

    private enum MessageType: String {
        case listWorkspaces = "files-workspaces"
        case listDirectory = "files-list"
        case read = "files-read"
        case write = "files-write"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown workspace file request type: \(rawType)"
            )
        }
        let requestID = try container.decode(WorkspaceFileRequestID.self, forKey: .requestID)
        switch type {
        case .listWorkspaces:
            self = .listWorkspaces(requestID: requestID)
        case .listDirectory:
            self = .listDirectory(
                requestID: requestID,
                workspaceID: try container.decode(String.self, forKey: .workspaceID),
                path: try container.decode(String.self, forKey: .path)
            )
        case .read:
            self = .read(
                requestID: requestID,
                workspaceID: try container.decode(String.self, forKey: .workspaceID),
                path: try container.decode(String.self, forKey: .path)
            )
        case .write:
            self = .write(
                requestID: requestID,
                workspaceID: try container.decode(String.self, forKey: .workspaceID),
                path: try container.decode(String.self, forKey: .path),
                expectedRevision: try container.decode(WorkspaceFileRevision.self, forKey: .expectedRevision),
                text: try container.decode(String.self, forKey: .text)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .listWorkspaces(let requestID):
            try container.encode(MessageType.listWorkspaces.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
        case .listDirectory(let requestID, let workspaceID, let path):
            try container.encode(MessageType.listDirectory.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(workspaceID, forKey: .workspaceID)
            try container.encode(path, forKey: .path)
        case .read(let requestID, let workspaceID, let path):
            try container.encode(MessageType.read.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(workspaceID, forKey: .workspaceID)
            try container.encode(path, forKey: .path)
        case .write(let requestID, let workspaceID, let path, let expectedRevision, let text):
            try container.encode(MessageType.write.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(workspaceID, forKey: .workspaceID)
            try container.encode(path, forKey: .path)
            try container.encode(expectedRevision, forKey: .expectedRevision)
            try container.encode(text, forKey: .text)
        }
    }
}

/// Results returned by the authenticated Files host. Errors and revision conflicts are explicit
/// response cases so callers never infer a save outcome from a missing frame.
public enum WorkspaceFileResponse: Codable, Equatable, Sendable {
    case workspaces(requestID: WorkspaceFileRequestID, result: WorkspaceListResult)
    case directory(requestID: WorkspaceFileRequestID, result: WorkspaceDirectoryListResult)
    case read(requestID: WorkspaceFileRequestID, result: WorkspaceFileReadResult)
    case write(requestID: WorkspaceFileRequestID, result: WorkspaceFileWriteResult)
    case conflict(requestID: WorkspaceFileRequestID, conflict: WorkspaceFileConflict)
    case error(requestID: WorkspaceFileRequestID, error: WorkspaceFileError)

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case workspaces = "ws"
        case workspaceID = "w"
        case path = "p"
        case entries = "e"
        case text = "x"
        case revision = "r"
        case code = "c"
        case requestID = "rid"
        case message = "m"
    }

    private enum MessageType: String {
        case workspaces = "files-workspaces"
        case directory = "files-directory"
        case read = "files-read"
        case write = "files-write"
        case conflict = "files-conflict"
        case error = "files-error"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown workspace file response type: \(rawType)"
            )
        }
        let requestID = try container.decode(WorkspaceFileRequestID.self, forKey: .requestID)
        switch type {
        case .workspaces:
            self = .workspaces(requestID: requestID, result: WorkspaceListResult(
                workspaces: try container.decode([WorkspaceSummary].self, forKey: .workspaces)
            ))
        case .directory:
            self = .directory(requestID: requestID, result: WorkspaceDirectoryListResult(
                workspaceID: try container.decode(String.self, forKey: .workspaceID),
                path: try container.decode(String.self, forKey: .path),
                entries: try container.decode([WorkspaceDirectoryEntry].self, forKey: .entries)
            ))
        case .read:
            self = .read(requestID: requestID, result: WorkspaceFileReadResult(
                workspaceID: try container.decode(String.self, forKey: .workspaceID),
                path: try container.decode(String.self, forKey: .path),
                text: try container.decode(String.self, forKey: .text),
                revision: try container.decode(WorkspaceFileRevision.self, forKey: .revision)
            ))
        case .write:
            self = .write(requestID: requestID, result: WorkspaceFileWriteResult(
                workspaceID: try container.decode(String.self, forKey: .workspaceID),
                path: try container.decode(String.self, forKey: .path),
                revision: try container.decode(WorkspaceFileRevision.self, forKey: .revision)
            ))
        case .conflict:
            self = .conflict(requestID: requestID, conflict: WorkspaceFileConflict(
                workspaceID: try container.decode(String.self, forKey: .workspaceID),
                path: try container.decode(String.self, forKey: .path),
                currentRevision: try container.decode(WorkspaceFileRevision.self, forKey: .revision)
            ))
        case .error:
            self = .error(requestID: requestID, error: WorkspaceFileError(
                code: try container.decode(WorkspaceFileErrorCode.self, forKey: .code),
                workspaceID: try container.decodeIfPresent(String.self, forKey: .workspaceID),
                path: try container.decodeIfPresent(String.self, forKey: .path),
                message: try container.decodeIfPresent(String.self, forKey: .message)
            ))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .workspaces(let requestID, let result):
            try container.encode(MessageType.workspaces.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(result.workspaces, forKey: .workspaces)
        case .directory(let requestID, let result):
            try container.encode(MessageType.directory.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(result.workspaceID, forKey: .workspaceID)
            try container.encode(result.path, forKey: .path)
            try container.encode(result.entries, forKey: .entries)
        case .read(let requestID, let result):
            try container.encode(MessageType.read.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(result.workspaceID, forKey: .workspaceID)
            try container.encode(result.path, forKey: .path)
            try container.encode(result.text, forKey: .text)
            try container.encode(result.revision, forKey: .revision)
        case .write(let requestID, let result):
            try container.encode(MessageType.write.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(result.workspaceID, forKey: .workspaceID)
            try container.encode(result.path, forKey: .path)
            try container.encode(result.revision, forKey: .revision)
        case .conflict(let requestID, let conflict):
            try container.encode(MessageType.conflict.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(conflict.workspaceID, forKey: .workspaceID)
            try container.encode(conflict.path, forKey: .path)
            try container.encode(conflict.currentRevision, forKey: .revision)
        case .error(let requestID, let error):
            try container.encode(MessageType.error.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(error.code, forKey: .code)
            try container.encodeIfPresent(error.workspaceID, forKey: .workspaceID)
            try container.encodeIfPresent(error.path, forKey: .path)
            try container.encodeIfPresent(error.message, forKey: .message)
        }
    }
}
