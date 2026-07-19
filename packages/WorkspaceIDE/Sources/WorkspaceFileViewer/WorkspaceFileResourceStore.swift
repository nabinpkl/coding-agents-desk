import Foundation

enum WorkspaceFileResource: Sendable {
    case data(Data)
    case file(URL, maximumBytes: Int)
}

public final class WorkspaceFileResourceStore: @unchecked Sendable {
    private let lock = NSLock()
    private var resources: [String: WorkspaceFileResource] = [:]

    public init() {}

    public func publish(documentData: Data) -> URL {
        register(.data(documentData))
    }

    public func publish(documentFile: URL, maximumBytes: Int) -> URL {
        precondition(maximumBytes > 0, "document file byte limit must be positive")
        return register(.file(documentFile, maximumBytes: maximumBytes))
    }

    public func revoke(_ resourceURL: URL) {
        guard resourceURL.pathComponents.count == 3,
              resourceURL.pathComponents[1] == "document" else { return }
        _ = lock.withLock { resources.removeValue(forKey: resourceURL.pathComponents[2]) }
    }

    public func removeAll() {
        lock.withLock { resources.removeAll() }
    }

    func publish(_ content: WorkspaceFileContent) -> URL? {
        let resource: WorkspaceFileResource
        switch content {
        case .text:
            removeAll()
            return nil
        case .documentData(let data):
            resource = .data(data)
        case .documentFile(let url, let maximumBytes):
            precondition(maximumBytes > 0, "document file byte limit must be positive")
            resource = .file(url, maximumBytes: maximumBytes)
        }

        removeAll()
        return register(resource)
    }

    func resource(for token: String) -> WorkspaceFileResource? {
        lock.withLock { resources[token] }
    }

    private func register(_ resource: WorkspaceFileResource) -> URL {
        let token = UUID().uuidString
        lock.withLock { resources[token] = resource }
        return URL(string: "\(AppSchemeHandler.scheme)://app/document/\(token)")!
    }
}
