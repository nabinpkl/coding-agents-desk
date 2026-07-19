import Foundation

struct WorkspaceTerminalOpenRequest: Equatable, Sendable {
    let requestID: String
    let workspaceID: String
    let preferredSessionName: String?
    let columns: UInt32
    let rows: UInt32
    let clientTitle: String
}

struct WorkspaceTerminalCoordinatorReady: Equatable, Sendable {
    let requestID: String
    let workspaceID: UUID
    let ptySessionName: String
    let pid: UInt32
}

enum WorkspaceTerminalCoordinatorError: Error, Equatable, Sendable {
    case workspaceUnavailable
    case invalidSession
    case launchFailed(String)
    case handoffTimedOut
    case sessionEnded
}

enum WorkspaceTerminalCoordinatorEvent: Equatable, Sendable {
    case handoffTimedOut(requestID: String, ready: WorkspaceTerminalCoordinatorReady)
}
