import Foundation
import OSLog
import WorkspaceIDE

struct WorkspaceIDEWindowPresentationDescriptor: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    var placement: WorkspaceWindowPlacement
    let cascadeOrdinal: Int
    var localState: WorkspaceIDELocalState
}

enum WorkspaceIDEWindowPresentationStoreError: Error, Equatable {
    case invalidDescriptor
}

@MainActor
final class WorkspaceIDEWindowPresentationStore {
    private struct Document: Codable {
        var presentations: [WorkspaceIDEWindowPresentationDescriptor]
    }

    static let maximumPresentations = 32

    private let url: URL
    private(set) var descriptors: [WorkspaceIDEWindowPresentationDescriptor]

    init(url: URL) {
        self.url = url
        descriptors = Self.read(url: url)
    }

    func upsert(_ descriptor: WorkspaceIDEWindowPresentationDescriptor) throws {
        guard descriptor.cascadeOrdinal >= 0,
              descriptor.placement.isValid else {
            throw WorkspaceIDEWindowPresentationStoreError.invalidDescriptor
        }
        var next = descriptors.filter { $0.id != descriptor.id }
        next.append(descriptor)
        if next.count > Self.maximumPresentations {
            next.removeFirst(next.count - Self.maximumPresentations)
        }
        try write(next)
        descriptors = next
    }

    func remove(id: UUID) throws {
        let next = descriptors.filter { $0.id != id }
        guard next.count != descriptors.count else { return }
        try write(next)
        descriptors = next
    }

    private func write(_ descriptors: [WorkspaceIDEWindowPresentationDescriptor]) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(Document(presentations: descriptors))
            .write(to: url, options: .atomic)
    }

    private static func read(url: URL) -> [WorkspaceIDEWindowPresentationDescriptor] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window").error(
                "Workspace IDE presentations could not be read: \(String(describing: error), privacy: .public)"
            )
            return []
        }
        guard data.count <= 1_048_576 else {
            Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window").error(
                "Workspace IDE presentations exceed the 1 MiB limit; nothing will be restored"
            )
            return []
        }
        do {
            let document = try JSONDecoder().decode(Document.self, from: data)
            return Array(document.presentations.prefix(maximumPresentations))
        } catch {
            Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window").error(
                "Workspace IDE presentations did not decode; nothing will be restored: \(String(describing: error), privacy: .public)"
            )
            return []
        }
    }
}
