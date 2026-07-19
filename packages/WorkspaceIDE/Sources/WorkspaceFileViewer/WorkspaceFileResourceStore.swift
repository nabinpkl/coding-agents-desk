import Foundation

enum WorkspaceFileResource: Sendable {
    case data(Data)
    case file(URL, maximumBytes: Int)
}

final class WorkspaceFileResourceStore: @unchecked Sendable {
    private let lock = NSLock()
    private var current: (token: String, resource: WorkspaceFileResource)?

    func publish(_ content: WorkspaceFileContent) -> URL? {
        let resource: WorkspaceFileResource
        switch content {
        case .text:
            lock.withLock { current = nil }
            return nil
        case .documentData(let data):
            resource = .data(data)
        case .documentFile(let url, let maximumBytes):
            precondition(maximumBytes > 0, "document file byte limit must be positive")
            resource = .file(url, maximumBytes: maximumBytes)
        }

        let token = UUID().uuidString
        lock.withLock { current = (token, resource) }
        return URL(string: "\(AppSchemeHandler.scheme)://app/document/\(token)")
    }

    func resource(for token: String) -> WorkspaceFileResource? {
        lock.withLock {
            guard current?.token == token else { return nil }
            return current?.resource
        }
    }
}
