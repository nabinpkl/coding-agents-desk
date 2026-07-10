import CryptoKit
import Foundation
import AgentDeskWire

enum WorkspaceFileServiceFailure: Error, Sendable {
    case workspaceUnavailable
    case invalidPath
    case notFound
    case forbidden
    case notDirectory
    case notFile
    case binary
    case invalidUTF8
    case tooLarge
    case writeFailed

    var code: WorkspaceFileErrorCode {
        switch self {
        // An unknown workspace shares the `.notFound` wire code (there is no separate code) but
        // carries a distinct message so a client can tell "no such workspace" from "no such file".
        case .workspaceUnavailable: .notFound
        case .invalidPath: .invalidPath
        case .notFound: .notFound
        case .forbidden: .forbidden
        case .notDirectory: .notDirectory
        case .notFile: .notFile
        case .binary: .binary
        case .invalidUTF8: .invalidUTF8
        case .tooLarge: .tooLarge
        case .writeFailed: .writeFailed
        }
    }

    var message: String {
        switch self {
        case .workspaceUnavailable: "Workspace is unavailable."
        case .invalidPath: "The requested path is invalid."
        case .notFound: "The requested item was not found."
        case .forbidden: "Access to this path is not permitted."
        case .notDirectory: "The requested path is not a directory."
        case .notFile: "The requested path is not a regular file."
        case .binary: "Binary files cannot be opened here."
        case .invalidUTF8: "This file is not valid UTF-8 text."
        case .tooLarge: "This file exceeds the supported size."
        case .writeFailed: "The file could not be saved."
        }
    }
}

typealias WorkspaceFileTemporaryWriter = (Int32, Data) throws -> Void

/// Handles one authenticated Files request against the current immutable workspace-store value.
/// It never interprets client paths as host paths: every filesystem operation begins at a verified
/// descriptor for a registered workspace root.
final class WorkspaceFileService {
    private let storeProvider: () -> WorkspaceStore
    private let maxUTF8Bytes: Int
    private let temporaryFileWriter: WorkspaceFileTemporaryWriter

    convenience init(
        store: WorkspaceStore,
        maxUTF8Bytes: Int,
        temporaryFileWriter: @escaping WorkspaceFileTemporaryWriter = WorkspaceFilePOSIX.writeAll
    ) {
        self.init(
            storeProvider: { store },
            maxUTF8Bytes: maxUTF8Bytes,
            temporaryFileWriter: temporaryFileWriter
        )
    }

    init(
        storeProvider: @escaping () -> WorkspaceStore,
        maxUTF8Bytes: Int,
        temporaryFileWriter: @escaping WorkspaceFileTemporaryWriter = WorkspaceFilePOSIX.writeAll
    ) {
        precondition(maxUTF8Bytes > 0, "workspace files byte limit must be positive")
        self.storeProvider = storeProvider
        self.maxUTF8Bytes = maxUTF8Bytes
        self.temporaryFileWriter = temporaryFileWriter
    }

    func handle(_ request: WorkspaceFileRequest) -> WorkspaceFileResponse {
        switch request {
        case .listWorkspaces(let requestID):
            return .workspaces(
                requestID: requestID,
                result: WorkspaceListResult(workspaces: storeProvider().workspaces.map {
                    WorkspaceSummary(id: $0.id.uuidString, name: $0.name)
                })
            )
        case .listDirectory(let requestID, let workspaceID, let path):
            return listDirectory(requestID: requestID, workspaceID: workspaceID, path: path)
        case .read(let requestID, let workspaceID, let path):
            return read(requestID: requestID, workspaceID: workspaceID, path: path)
        case .write(let requestID, let workspaceID, let path, let expectedRevision, let text):
            return write(
                requestID: requestID,
                workspaceID: workspaceID,
                path: path,
                expectedRevision: expectedRevision,
                text: text
            )
        }
    }

    private func listDirectory(
        requestID: WorkspaceFileRequestID,
        workspaceID: String,
        path: String
    ) -> WorkspaceFileResponse {
        do {
            let workspace = try workspace(id: workspaceID)
            let components = try components(in: path, allowRoot: true)
            let directory = try WorkspaceFilePOSIX.openDirectory(root: workspace.root, components: components)
            let entries = try WorkspaceFilePOSIX.list(directory: directory, relativeDirectory: path)
            return .directory(
                requestID: requestID,
                result: WorkspaceDirectoryListResult(workspaceID: workspaceID, path: path, entries: entries)
            )
        } catch let failure as WorkspaceFileServiceFailure {
            return failureResponse(requestID: requestID, workspaceID: workspaceID, path: path, failure: failure)
        } catch {
            return failureResponse(requestID: requestID, workspaceID: workspaceID, path: path, failure: .notFound)
        }
    }

    private func read(
        requestID: WorkspaceFileRequestID,
        workspaceID: String,
        path: String
    ) -> WorkspaceFileResponse {
        do {
            let workspace = try workspace(id: workspaceID)
            let file = try WorkspaceFilePOSIX.openRegularFile(
                root: workspace.root,
                components: try components(in: path, allowRoot: false)
            )
            let content = try WorkspaceFilePOSIX.readUTF8(file: file.file, maxBytes: maxUTF8Bytes)
            return .read(
                requestID: requestID,
                result: WorkspaceFileReadResult(
                    workspaceID: workspaceID,
                    path: path,
                    text: content.text,
                    revision: revision(for: content.data)
                )
            )
        } catch let failure as WorkspaceFileServiceFailure {
            return failureResponse(requestID: requestID, workspaceID: workspaceID, path: path, failure: failure)
        } catch {
            return failureResponse(requestID: requestID, workspaceID: workspaceID, path: path, failure: .notFound)
        }
    }

    private func write(
        requestID: WorkspaceFileRequestID,
        workspaceID: String,
        path: String,
        expectedRevision: WorkspaceFileRevision,
        text: String
    ) -> WorkspaceFileResponse {
        do {
            let newData = Data(text.utf8)
            guard newData.count <= maxUTF8Bytes else { throw WorkspaceFileServiceFailure.tooLarge }
            guard !newData.contains(0) else { throw WorkspaceFileServiceFailure.binary }

            let workspace = try workspace(id: workspaceID)
            let file = try WorkspaceFilePOSIX.openRegularFile(
                root: workspace.root,
                components: try components(in: path, allowRoot: false)
            )
            let current = try WorkspaceFilePOSIX.readUTF8(file: file.file, maxBytes: maxUTF8Bytes)
            let currentRevision = revision(for: current.data)
            guard currentRevision == expectedRevision else {
                return .conflict(
                    requestID: requestID,
                    conflict: WorkspaceFileConflict(
                        workspaceID: workspaceID,
                        path: path,
                        currentRevision: currentRevision
                    )
                )
            }

            do {
                try WorkspaceFilePOSIX.writeAtomically(
                    data: newData,
                    parent: file.parent,
                    name: file.name,
                    writeTemporaryFile: temporaryFileWriter
                )
            } catch {
                throw WorkspaceFileServiceFailure.writeFailed
            }
            return .write(
                requestID: requestID,
                result: WorkspaceFileWriteResult(
                    workspaceID: workspaceID,
                    path: path,
                    revision: revision(for: newData)
                )
            )
        } catch let failure as WorkspaceFileServiceFailure {
            return failureResponse(requestID: requestID, workspaceID: workspaceID, path: path, failure: failure)
        } catch {
            return failureResponse(requestID: requestID, workspaceID: workspaceID, path: path, failure: .writeFailed)
        }
    }

    private func workspace(id: String) throws -> Workspace {
        guard let identifier = UUID(uuidString: id),
              let workspace = storeProvider().workspace(id: identifier)
        else {
            throw WorkspaceFileServiceFailure.workspaceUnavailable
        }
        return workspace
    }

    private func components(in path: String, allowRoot: Bool) throws -> [String] {
        if path.isEmpty {
            guard allowRoot else { throw WorkspaceFileServiceFailure.invalidPath }
            return []
        }
        guard !path.hasPrefix("/") else { throw WorkspaceFileServiceFailure.invalidPath }

        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        // Reject `.`/`..`/empty and any embedded NUL: a NUL would be silently truncated by the
        // C-string conversion at the openat boundary, so the validated string and the string
        // actually opened would diverge.
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") }) else {
            throw WorkspaceFileServiceFailure.invalidPath
        }
        return parts
    }

    private func revision(for data: Data) -> WorkspaceFileRevision {
        WorkspaceFileRevision(digest: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }

    private func failureResponse(
        requestID: WorkspaceFileRequestID,
        workspaceID: String?,
        path: String?,
        failure: WorkspaceFileServiceFailure
    ) -> WorkspaceFileResponse {
        .error(
            requestID: requestID,
            error: WorkspaceFileError(
                code: failure.code,
                workspaceID: workspaceID,
                path: path,
                message: failure.message
            )
        )
    }
}
