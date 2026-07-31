import AgentDeskWire
import CoreGraphics
import Foundation

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

struct AgentWindowFrame: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ frame: CGRect) {
        x = frame.origin.x
        y = frame.origin.y
        width = frame.width
        height = frame.height
    }

    var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

/// Where one Agents window was when the host last ran, so a restart can put it back.
///
/// Metadata only, mirroring `TerminalWindowPresentationStore`: no feed content, no transcript, no
/// terminal bytes. The conversation lives in the sidecar and the window rebuilds it on reconnect,
/// so the only thing a restart actually loses is the window itself.
struct AgentWindowPresentationDescriptor: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    var frame: AgentWindowFrame
    /// The Desktop the window was opened from. Kept so a restored window still participates in
    /// per-Desktop cascade placement when the user opens another one there.
    let desktopSpaceID: UInt64?
    let cascadeOrdinal: Int
    /// Absent when the window had no terminal pane open, which is also what a window restores to.
    var terminal: AgentWindowTerminalAttachment?
    /// How far the window was zoomed, as `AgentWindowZoom`'s step. Belongs here for the same reason
    /// the frame does: it is how big the window's contents were, and a restart that puts the window
    /// back at the wrong size has not really put it back.
    var zoomStep: Int

    init(
        id: UUID,
        frame: AgentWindowFrame,
        desktopSpaceID: UInt64?,
        cascadeOrdinal: Int,
        terminal: AgentWindowTerminalAttachment? = nil,
        zoomStep: Int = 0
    ) {
        self.id = id
        self.frame = frame
        self.desktopSpaceID = desktopSpaceID
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
              descriptor.frame.width >= 1,
              descriptor.frame.height >= 1,
              descriptor.frame.x.isFinite,
              descriptor.frame.y.isFinite else {
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

    private static func read(url: URL) -> [AgentWindowPresentationDescriptor] {
        guard let data = try? Data(contentsOf: url),
              data.count <= 1_048_576,
              let document = try? JSONDecoder().decode(Document.self, from: data) else {
            return []
        }
        return Array(document.presentations.prefix(maximumPresentations))
    }
}

/// Keeps a remembered frame reachable when the display setup changed between host runs. Takes the
/// visible frames rather than reading `NSScreen` so the placement rule is testable without a
/// display, the same shape `SpaceAgentController` uses for its own screen geometry.
enum AgentWindowScreenPlacement {
    static func constrained(_ frame: CGRect, within visibleFrames: [CGRect]) -> CGRect {
        guard !visibleFrames.isEmpty else { return frame }
        let target = visibleFrames.max { lhs, rhs in
            intersectionArea(lhs, frame) < intersectionArea(rhs, frame)
        } ?? visibleFrames[0]
        let width = min(frame.width, target.width)
        let height = min(frame.height, target.height)
        return CGRect(
            x: min(max(frame.minX, target.minX), target.maxX - width),
            y: min(max(frame.minY, target.minY), target.maxY - height),
            width: width,
            height: height
        )
    }

    private static func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
        let intersection = lhs.intersection(rhs)
        guard !intersection.isNull else { return 0 }
        return intersection.width * intersection.height
    }
}
