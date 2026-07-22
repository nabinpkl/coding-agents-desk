import CoreGraphics
import Foundation

public struct TerminalWindowFrame: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(_ frame: CGRect) {
        x = frame.origin.x
        y = frame.origin.y
        width = frame.width
        height = frame.height
    }

    public var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

public struct TerminalWindowPresentationDescriptor: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let sessionName: String
    public let workspaceID: UUID?
    public var frame: TerminalWindowFrame
    public let cascadeOrdinal: Int
    public let workspaceLabel: String

    public init(
        id: UUID,
        sessionName: String,
        workspaceID: UUID?,
        frame: TerminalWindowFrame,
        cascadeOrdinal: Int,
        workspaceLabel: String
    ) {
        self.id = id
        self.sessionName = sessionName
        self.workspaceID = workspaceID
        self.frame = frame
        self.cascadeOrdinal = cascadeOrdinal
        self.workspaceLabel = workspaceLabel
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

    public init(url: URL) {
        self.url = url
        descriptors = Self.read(url: url)
    }

    public func upsert(_ descriptor: TerminalWindowPresentationDescriptor) throws {
        guard descriptor.sessionName.utf8.count <= 256,
              descriptor.workspaceLabel.utf8.count <= 256,
              descriptor.cascadeOrdinal >= 0,
              descriptor.frame.width >= 1,
              descriptor.frame.height >= 1 else {
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

    private static func read(url: URL) -> [TerminalWindowPresentationDescriptor] {
        guard let data = try? Data(contentsOf: url),
              data.count <= 1_048_576,
              let document = try? JSONDecoder().decode(Document.self, from: data) else {
            return []
        }
        return Array(document.presentations.prefix(maximumPresentations))
    }
}
