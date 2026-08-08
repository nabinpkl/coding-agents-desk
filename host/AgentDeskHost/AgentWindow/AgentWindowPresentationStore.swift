import AgentDeskWire
import CoreGraphics
import Foundation
import os

/// What a window's terminal pane was serving, in the form the open flow needs to ask for it again.
///
/// The PTY session name is deterministic from the agent identity, so this is enough to land back on
/// the same terminal two ways: the leased session is still running and the pane reattaches to the
/// live process, or it was reaped and the harness relaunches with `--resume` against the same
/// session in the same project.
struct AgentWindowTerminalAttachment: Codable, Equatable, Sendable {
    let requestID: String
    let context: AgentResumeTerminalContext
    let ptySessionName: String
}

/// Where one Agents window was when the host last ran, so a restart can put it back.
///
/// Metadata only, mirroring `TerminalWindowPresentationStore`: no feed content, no transcript, no
/// terminal bytes. The conversation lives in the sidecar and the window rebuilds it on reconnect,
/// so the only thing a restart actually loses is the window itself.
struct AgentWindowPresentationDescriptor: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    var placement: WorkspaceWindowPlacement
    let cascadeOrdinal: Int
    /// Absent when the window had no terminal pane open, which is also what a window restores to.
    var terminal: AgentWindowTerminalAttachment?
    /// How far the window was zoomed, as `PanelWindowZoom`'s step. Belongs here for the same reason
    /// the frame does: it is how big the window's contents were, and a restart that puts the window
    /// back at the wrong size has not really put it back.
    var zoomStep: Int

    init(
        id: UUID,
        placement: WorkspaceWindowPlacement,
        cascadeOrdinal: Int,
        terminal: AgentWindowTerminalAttachment? = nil,
        zoomStep: Int = 0
    ) {
        self.id = id
        self.placement = placement
        self.cascadeOrdinal = cascadeOrdinal
        self.terminal = terminal
        self.zoomStep = zoomStep
    }

}

enum AgentWindowPresentationStoreError: Error, Equatable {
    /// A frame that is empty, off in NaN space, or carries a negative cascade ordinal would come
    /// back as an unusable window, so it is refused at the boundary rather than written out.
    case invalidDescriptor
}

@MainActor
final class AgentWindowPresentationStore {
    private struct Document: Codable {
        var presentations: [AgentWindowPresentationDescriptor]
    }

    static let maximumPresentations = 32

    private let url: URL
    private(set) var descriptors: [AgentWindowPresentationDescriptor]

    init(url: URL) {
        self.url = url
        descriptors = Self.read(url: url)
    }

    func upsert(_ descriptor: AgentWindowPresentationDescriptor) throws {
        guard descriptor.cascadeOrdinal >= 0,
              descriptor.placement.isValid else {
            throw AgentWindowPresentationStoreError.invalidDescriptor
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

    private func write(_ descriptors: [AgentWindowPresentationDescriptor]) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONEncoder().encode(Document(presentations: descriptors))
        try data.write(to: url, options: .atomic)
    }

    /// A document that exists but does not decode is REPORTED, not just skipped.
    ///
    /// Restoring nothing looks identical to having nothing stored, and that is what made a schema
    /// change that broke this file cost an afternoon: every Agents window stopped coming back, the
    /// host logged not one line about it, and the only way to see the cause was to read the JSON by
    /// hand. An absent file is still silent -- that genuinely is "nothing stored".
    private static func read(url: URL) -> [AgentWindowPresentationDescriptor] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            Logger(subsystem: Config.logSubsystem, category: "agent-window").error(
                "agent-window presentations could not be read: \(String(describing: error), privacy: .public)"
            )
            return []
        }
        guard data.count <= 1_048_576 else {
            Logger(subsystem: Config.logSubsystem, category: "agent-window").error(
                "agent-window presentations: refusing \(data.count, privacy: .public) bytes at \(url.lastPathComponent, privacy: .public); nothing will be restored"
            )
            return []
        }
        do {
            let document = try JSONDecoder().decode(Document.self, from: data)
            return Array(document.presentations.prefix(maximumPresentations))
        } catch {
            Logger(subsystem: Config.logSubsystem, category: "agent-window").error(
                "agent-window presentations: \(url.lastPathComponent, privacy: .public) did not decode, nothing will be restored: \(String(describing: error), privacy: .public)"
            )
            return []
        }
    }
}
