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
    public let synchronizing: Bool

    public init(columns: UInt32, rows: UInt32, revision: UInt64, fitScale: Double, synchronizing: Bool) {
        self.columns = columns
        self.rows = rows
        self.revision = revision
        self.fitScale = fitScale
        self.synchronizing = synchronizing
    }
}

/// Read-only seam used by the visible test harness. It exposes geometry and
/// synchronization counters, never terminal text or checkpoint bytes.
@MainActor
public protocol TerminalWindowReplayInspectable: TerminalEmulatorWindow {
    var replayDiagnostics: TerminalWindowReplayDiagnostics { get }
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
