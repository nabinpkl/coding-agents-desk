import CoreGraphics
import Foundation

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

public protocol TerminalEmulatorSpawn: AnyObject {
    func spawn(cwd: URL, into frame: CGRect, completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void)
}
