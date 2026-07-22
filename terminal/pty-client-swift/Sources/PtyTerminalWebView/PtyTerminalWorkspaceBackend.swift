import Foundation
import PtyClientSwift
import PtyTerminalSession

public struct PtyTerminalOpenRequest: Sendable {
    public let sessionName: String
    public let createIfMissing: Bool
    public let dimensions: PtyTerminalDimensions

    public init(sessionName: String, createIfMissing: Bool, dimensions: PtyTerminalDimensions) {
        self.sessionName = sessionName
        self.createIfMissing = createIfMissing
        self.dimensions = dimensions
    }
}

@MainActor
public protocol PtyTerminalWorkspaceBackend: AnyObject {
    func makeFreshSessionName() -> String
    func openSession(_ request: PtyTerminalOpenRequest) async throws -> PtySessionConnection
    func listSessions() async throws -> [PtySessionSummary]
    func sessionSnapshots() async throws -> AsyncThrowingStream<[PtySessionSummary], Error>
    func killSession(named name: String) async throws
    func closeClient(sessionName: String, clientID: UInt64) async throws
}
