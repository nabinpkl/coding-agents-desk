import CoreGraphics
import Foundation

@MainActor
public protocol TerminalEmulatorWindow: AnyObject {
    var isOpen: Bool { get }
    var assignedDesktopWindowID: UInt32? { get }

    func place(into frame: CGRect)
    func park()
    func unpark(into frame: CGRect)
    func raise()
    func prepareForAssignedDesktop(into frame: CGRect)
    func revealAfterAssignedDesktop(into frame: CGRect, focus: Bool)
    func close()
    func setTerminalFontSize(_ pointSize: CGFloat)
    func setWorkspaceLabel(_ workspaceName: String)
    func focusForAccessibility()
}

public enum TerminalWindowCloseReason: Sendable {
    case user
    case sessionExited
}

/// Optional presentation seam used by the host's metadata-only restoration
/// registry. Terminal bytes never cross this interface.
@MainActor
public protocol TerminalWindowPresentationTrackable: TerminalEmulatorWindow {
    var currentFrame: CGRect { get }
    func observePresentation(
        frameChanged: @escaping (CGRect) -> Void,
        closed: @escaping (TerminalWindowCloseReason) -> Void
    )
    func orderWithoutFocus()
    func closePreservingPresentation()
}

public struct TerminalWindowReplayDiagnostics: Equatable, Sendable {
    public let columns: UInt32
    public let rows: UInt32
    public let revision: UInt64
    public let fitScale: Double
    public let viewportCropped: Bool
    public let synchronizing: Bool
    public let ownershipEpoch: UInt64
    public let ownerClientID: UInt64
    public let isOwner: Bool
    public let sourceColumns: UInt32
    public let sourceRows: UInt32
    public let sourceRevision: UInt64
    public let viewColumns: UInt32
    public let viewRows: UInt32

    public init(
        columns: UInt32,
        rows: UInt32,
        revision: UInt64,
        fitScale: Double,
        viewportCropped: Bool,
        synchronizing: Bool,
        ownershipEpoch: UInt64 = 0,
        ownerClientID: UInt64 = 0,
        isOwner: Bool = false,
        sourceColumns: UInt32 = 0,
        sourceRows: UInt32 = 0,
        sourceRevision: UInt64 = 0,
        viewColumns: UInt32 = 0,
        viewRows: UInt32 = 0
    ) {
        self.columns = columns
        self.rows = rows
        self.revision = revision
        self.fitScale = fitScale
        self.viewportCropped = viewportCropped
        self.synchronizing = synchronizing
        self.ownershipEpoch = ownershipEpoch
        self.ownerClientID = ownerClientID
        self.isOwner = isOwner
        self.sourceColumns = sourceColumns
        self.sourceRows = sourceRows
        self.sourceRevision = sourceRevision
        self.viewColumns = viewColumns
        self.viewRows = viewRows
    }
}

/// Read-only seam used by the visible test harness. It exposes geometry and
/// synchronization counters, never terminal text or checkpoint bytes.
@MainActor
public protocol TerminalWindowReplayInspectable: TerminalEmulatorWindow {
    var replayDiagnostics: TerminalWindowReplayDiagnostics { get }
    func claimViewportForReplay()
    func flushViewportForReplay()
    func sendInputForReplay(_ text: String)
}

@MainActor
public protocol TerminalEmulatorSpawn: AnyObject {
    func spawn(
        sessionName: String,
        cwd: URL,
        into frame: CGRect,
        completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void
    )
}
