import CoreGraphics
import Foundation
import OSLog
import PtyTerminalWebView
import WindowPlacement

public struct TerminalWindowPresentationDescriptor: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let workspace: PtyTerminalWorkspaceState
    public let workspaceID: UUID?
    public var placement: DesktopWindowPlacement
    public let cascadeOrdinal: Int
    public let workspaceLabel: String

    public init(
        id: UUID,
        workspace: PtyTerminalWorkspaceState,
        workspaceID: UUID?,
        placement: DesktopWindowPlacement,
        cascadeOrdinal: Int,
        workspaceLabel: String
    ) {
        self.id = id
        self.workspace = workspace
        self.workspaceID = workspaceID
        self.placement = placement
        self.cascadeOrdinal = cascadeOrdinal
        self.workspaceLabel = workspaceLabel
    }

    public init(
        id: UUID,
        sessionName: String,
        workspaceID: UUID?,
        placement: DesktopWindowPlacement,
        cascadeOrdinal: Int,
        workspaceLabel: String
    ) {
        self.init(
            id: id,
            workspace: PtyTerminalWorkspaceState(restoringSessionName: sessionName),
            workspaceID: workspaceID,
            placement: placement,
            cascadeOrdinal: cascadeOrdinal,
            workspaceLabel: workspaceLabel
        )
    }

    public var sessionName: String { workspace.selectedPane?.sessionName ?? "" }
    public var sessionNames: [String] { workspace.panes.map(\.sessionName) }

    private enum CodingKeys: String, CodingKey {
        case id, workspace, sessionName, workspaceID, placement, cascadeOrdinal, workspaceLabel
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        if let decoded = try values.decodeIfPresent(PtyTerminalWorkspaceState.self, forKey: .workspace) {
            workspace = decoded
        } else {
            workspace = PtyTerminalWorkspaceState(
                restoringSessionName: try values.decode(String.self, forKey: .sessionName)
            )
        }
        workspaceID = try values.decodeIfPresent(UUID.self, forKey: .workspaceID)
        placement = try values.decode(DesktopWindowPlacement.self, forKey: .placement)
        cascadeOrdinal = try values.decode(Int.self, forKey: .cascadeOrdinal)
        workspaceLabel = try values.decode(String.self, forKey: .workspaceLabel)
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(workspace, forKey: .workspace)
        try values.encodeIfPresent(workspaceID, forKey: .workspaceID)
        try values.encode(placement, forKey: .placement)
        try values.encode(cascadeOrdinal, forKey: .cascadeOrdinal)
        try values.encode(workspaceLabel, forKey: .workspaceLabel)
    }
}

/// Metadata-only persistence for standalone terminal windows. Terminal bytes,
/// checkpoints, history, and user input are deliberately absent from this type.
@MainActor
public final class TerminalWindowPresentationStore {
    private struct Document: Codable {
        var presentations: [TerminalWindowPresentationDescriptor]
    }

    public static let maximumPresentations = 128

    private let url: URL
    public private(set) var descriptors: [TerminalWindowPresentationDescriptor]

    public init(
        url: URL,
        loggerSubsystem: String = "com.example.agentdesk.AgentDeskTerminalReplay"
    ) {
        self.url = url
        descriptors = Self.read(url: url, loggerSubsystem: loggerSubsystem)
    }

    public func upsert(_ descriptor: TerminalWindowPresentationDescriptor) throws {
        guard descriptor.workspace.profile == .workspace,
              !descriptor.sessionNames.isEmpty,
              descriptor.sessionNames.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }),
              descriptor.workspaceLabel.utf8.count <= 256,
              descriptor.cascadeOrdinal >= 0,
              descriptor.placement.isValid else {
            throw CocoaError(.validationMissingMandatoryProperty)
        }
        var next = descriptors.filter { $0.id != descriptor.id }
        next.append(descriptor)
        if next.count > Self.maximumPresentations {
            next.removeFirst(next.count - Self.maximumPresentations)
        }
        try write(next)
        descriptors = next
    }

    public func remove(id: UUID) throws {
        let next = descriptors.filter { $0.id != id }
        guard next.count != descriptors.count else { return }
        try write(next)
        descriptors = next
    }

    private func write(_ descriptors: [TerminalWindowPresentationDescriptor]) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(Document(presentations: descriptors))
        try data.write(to: url, options: .atomic)
    }

    private static func read(url: URL, loggerSubsystem: String) -> [TerminalWindowPresentationDescriptor] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let logger = Logger(subsystem: loggerSubsystem, category: "terminal-restoration")
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            logger.error("terminal presentations could not be read: \(String(describing: error), privacy: .public)")
            return []
        }
        guard data.count <= 1_048_576 else {
            logger.error("terminal presentations exceed the 1 MiB limit; nothing will be restored")
            return []
        }
        do {
            let document = try JSONDecoder().decode(Document.self, from: data)
            return Array(document.presentations.prefix(maximumPresentations))
        } catch {
            logger.error("terminal presentations did not decode; nothing will be restored: \(String(describing: error), privacy: .public)")
            return []
        }
    }
}
