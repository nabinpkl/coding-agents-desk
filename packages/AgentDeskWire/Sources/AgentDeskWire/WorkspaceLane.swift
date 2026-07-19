import Foundation

/// An opaque caller-generated identifier used to make a shared-state mutation idempotent.
public struct WorkspaceIDEOperationID: Codable, Equatable, Hashable, Sendable {
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

public struct WorkspaceIDESharedState: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let revision: UInt64
    public let orderedOpenPaths: [String]
    public let expandedDirectoryPaths: [String]

    public init(
        workspaceID: String,
        revision: UInt64,
        orderedOpenPaths: [String],
        expandedDirectoryPaths: [String]
    ) {
        self.workspaceID = workspaceID
        self.revision = revision
        self.orderedOpenPaths = orderedOpenPaths
        self.expandedDirectoryPaths = expandedDirectoryPaths
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case workspaceID = "w"
        case revision = "r"
        case orderedOpenPaths = "o"
        case expandedDirectoryPaths = "e"
    }
}

public enum WorkspaceIDEOperation: Codable, Equatable, Sendable {
    case open(path: String)
    case close(path: String)
    case reorder(orderedPaths: [String])
    case expand(path: String)
    case collapse(path: String)

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case path = "p"
        case orderedPaths = "o"
    }

    private enum MessageType: String {
        case open
        case close
        case reorder
        case expand
        case collapse
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown workspace IDE operation: \(rawType)"
            )
        }
        switch type {
        case .open:
            self = .open(path: try container.decode(String.self, forKey: .path))
        case .close:
            self = .close(path: try container.decode(String.self, forKey: .path))
        case .reorder:
            self = .reorder(orderedPaths: try container.decode([String].self, forKey: .orderedPaths))
        case .expand:
            self = .expand(path: try container.decode(String.self, forKey: .path))
        case .collapse:
            self = .collapse(path: try container.decode(String.self, forKey: .path))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .open(let path):
            try container.encode(MessageType.open.rawValue, forKey: .type)
            try container.encode(path, forKey: .path)
        case .close(let path):
            try container.encode(MessageType.close.rawValue, forKey: .type)
            try container.encode(path, forKey: .path)
        case .reorder(let orderedPaths):
            try container.encode(MessageType.reorder.rawValue, forKey: .type)
            try container.encode(orderedPaths, forKey: .orderedPaths)
        case .expand(let path):
            try container.encode(MessageType.expand.rawValue, forKey: .type)
            try container.encode(path, forKey: .path)
        case .collapse(let path):
            try container.encode(MessageType.collapse.rawValue, forKey: .type)
            try container.encode(path, forKey: .path)
        }
    }
}

public struct WorkspaceGitStatusEntry: Codable, Equatable, Sendable {
    public let relativePath: String
    public let indexStatus: String?
    public let workTreeStatus: String?

    public init(relativePath: String, indexStatus: String?, workTreeStatus: String?) {
        self.relativePath = relativePath
        self.indexStatus = indexStatus
        self.workTreeStatus = workTreeStatus
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case relativePath = "p"
        case indexStatus = "i"
        case workTreeStatus = "x"
    }
}

public struct WorkspaceGitStatusResult: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let generation: UInt64
    public let entries: [WorkspaceGitStatusEntry]

    public init(workspaceID: String, generation: UInt64, entries: [WorkspaceGitStatusEntry]) {
        self.workspaceID = workspaceID
        self.generation = generation
        self.entries = entries
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case workspaceID = "w"
        case generation = "g"
        case entries = "e"
    }
}

public struct WorkspaceChangedPush: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let generation: UInt64
    public let changedPaths: [String]

    public init(workspaceID: String, generation: UInt64, changedPaths: [String]) {
        self.workspaceID = workspaceID
        self.generation = generation
        self.changedPaths = changedPaths
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case workspaceID = "w"
        case generation = "g"
        case changedPaths = "p"
    }
}

public enum WorkspaceLaneErrorCode: String, Codable, CaseIterable, Equatable, Sendable {
    case invalidRequest
    case workspaceUnavailable
    case revisionConflict
    case operationRejected
    case gitUnavailable
}

public struct WorkspaceLaneError: Codable, Equatable, Sendable {
    public let requestID: WorkspaceRequestID?
    public let workspaceID: String?
    public let code: WorkspaceLaneErrorCode
    public let message: String?

    public init(
        requestID: WorkspaceRequestID? = nil,
        workspaceID: String? = nil,
        code: WorkspaceLaneErrorCode,
        message: String? = nil
    ) {
        self.requestID = requestID
        self.workspaceID = workspaceID
        self.code = code
        self.message = message
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case requestID = "rid"
        case workspaceID = "w"
        case code = "c"
        case message = "m"
    }
}

public enum WorkspaceLaneRequest: Codable, Equatable, Sendable {
    case files(WorkspaceFileRequest)
    case subscribe(requestID: WorkspaceRequestID, workspaceID: String)
    case unsubscribe(requestID: WorkspaceRequestID, workspaceID: String)
    case operation(
        requestID: WorkspaceRequestID,
        workspaceID: String,
        baseRevision: UInt64,
        operationID: WorkspaceIDEOperationID,
        operation: WorkspaceIDEOperation
    )
    case gitStatus(requestID: WorkspaceRequestID, workspaceID: String)

    public var requestID: WorkspaceRequestID {
        switch self {
        case .files(let request): request.requestID
        case .subscribe(let requestID, _),
             .unsubscribe(let requestID, _),
             .operation(let requestID, _, _, _, _),
             .gitStatus(let requestID, _): requestID
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case files = "f"
        case requestID = "rid"
        case workspaceID = "w"
        case baseRevision = "br"
        case operationID = "oid"
        case operation = "op"
    }

    private enum MessageType: String {
        case files
        case subscribe = "ide-subscribe"
        case unsubscribe = "ide-unsubscribe"
        case operation = "ide-operation"
        case gitStatus = "git-status"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown workspace lane request: \(rawType)"
            )
        }
        switch type {
        case .files:
            self = .files(try container.decode(WorkspaceFileRequest.self, forKey: .files))
        case .subscribe:
            self = .subscribe(
                requestID: try container.decode(WorkspaceRequestID.self, forKey: .requestID),
                workspaceID: try container.decode(String.self, forKey: .workspaceID)
            )
        case .unsubscribe:
            self = .unsubscribe(
                requestID: try container.decode(WorkspaceRequestID.self, forKey: .requestID),
                workspaceID: try container.decode(String.self, forKey: .workspaceID)
            )
        case .operation:
            self = .operation(
                requestID: try container.decode(WorkspaceRequestID.self, forKey: .requestID),
                workspaceID: try container.decode(String.self, forKey: .workspaceID),
                baseRevision: try container.decode(UInt64.self, forKey: .baseRevision),
                operationID: try container.decode(WorkspaceIDEOperationID.self, forKey: .operationID),
                operation: try container.decode(WorkspaceIDEOperation.self, forKey: .operation)
            )
        case .gitStatus:
            self = .gitStatus(
                requestID: try container.decode(WorkspaceRequestID.self, forKey: .requestID),
                workspaceID: try container.decode(String.self, forKey: .workspaceID)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .files(let request):
            try container.encode(MessageType.files.rawValue, forKey: .type)
            try container.encode(request, forKey: .files)
        case .subscribe(let requestID, let workspaceID):
            try container.encode(MessageType.subscribe.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(workspaceID, forKey: .workspaceID)
        case .unsubscribe(let requestID, let workspaceID):
            try container.encode(MessageType.unsubscribe.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(workspaceID, forKey: .workspaceID)
        case .operation(let requestID, let workspaceID, let baseRevision, let operationID, let operation):
            try container.encode(MessageType.operation.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(workspaceID, forKey: .workspaceID)
            try container.encode(baseRevision, forKey: .baseRevision)
            try container.encode(operationID, forKey: .operationID)
            try container.encode(operation, forKey: .operation)
        case .gitStatus(let requestID, let workspaceID):
            try container.encode(MessageType.gitStatus.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(workspaceID, forKey: .workspaceID)
        }
    }
}

public enum WorkspaceLaneResponse: Codable, Equatable, Sendable {
    case files(WorkspaceFileResponse)
    case ideSnapshot(requestID: WorkspaceRequestID?, state: WorkspaceIDESharedState)
    case gitStatus(requestID: WorkspaceRequestID?, result: WorkspaceGitStatusResult)
    case workspaceChanged(WorkspaceChangedPush)
    case error(WorkspaceLaneError)

    public var requestID: WorkspaceRequestID? {
        switch self {
        case .files(let response): response.requestID
        case .ideSnapshot(let requestID, _), .gitStatus(let requestID, _): requestID
        case .workspaceChanged: nil
        case .error(let error): error.requestID
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case files = "f"
        case requestID = "rid"
        case state = "s"
        case gitStatus = "g"
        case change = "ch"
        case error = "e"
    }

    private enum MessageType: String {
        case files
        case ideSnapshot = "ide-snapshot"
        case gitStatus = "git-status-result"
        case workspaceChanged = "workspace-changed"
        case error = "workspace-error"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown workspace lane response: \(rawType)"
            )
        }
        switch type {
        case .files:
            self = .files(try container.decode(WorkspaceFileResponse.self, forKey: .files))
        case .ideSnapshot:
            self = .ideSnapshot(
                requestID: try container.decodeIfPresent(WorkspaceRequestID.self, forKey: .requestID),
                state: try container.decode(WorkspaceIDESharedState.self, forKey: .state)
            )
        case .gitStatus:
            self = .gitStatus(
                requestID: try container.decodeIfPresent(WorkspaceRequestID.self, forKey: .requestID),
                result: try container.decode(WorkspaceGitStatusResult.self, forKey: .gitStatus)
            )
        case .workspaceChanged:
            self = .workspaceChanged(try container.decode(WorkspaceChangedPush.self, forKey: .change))
        case .error:
            self = .error(try container.decode(WorkspaceLaneError.self, forKey: .error))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .files(let response):
            try container.encode(MessageType.files.rawValue, forKey: .type)
            try container.encode(response, forKey: .files)
        case .ideSnapshot(let requestID, let state):
            try container.encode(MessageType.ideSnapshot.rawValue, forKey: .type)
            try container.encodeIfPresent(requestID, forKey: .requestID)
            try container.encode(state, forKey: .state)
        case .gitStatus(let requestID, let result):
            try container.encode(MessageType.gitStatus.rawValue, forKey: .type)
            try container.encodeIfPresent(requestID, forKey: .requestID)
            try container.encode(result, forKey: .gitStatus)
        case .workspaceChanged(let change):
            try container.encode(MessageType.workspaceChanged.rawValue, forKey: .type)
            try container.encode(change, forKey: .change)
        case .error(let error):
            try container.encode(MessageType.error.rawValue, forKey: .type)
            try container.encode(error, forKey: .error)
        }
    }
}
