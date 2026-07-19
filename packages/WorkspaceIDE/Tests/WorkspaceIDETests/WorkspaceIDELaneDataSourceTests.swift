import AgentDeskWire
import Foundation
import Testing
@testable import WorkspaceIDE

@Test func laneDataSourceMapsCorrelatedResponsesAndEveryPushType() async throws {
    let state = WorkspaceIDESharedState(
        workspaceID: "w1",
        revision: 3,
        orderedOpenPaths: ["README.md"],
        expandedDirectoryPaths: ["Sources"]
    )
    let git = WorkspaceGitStatusResult(
        workspaceID: "w1",
        generation: 4,
        entries: [WorkspaceGitStatusEntry(
            relativePath: "README.md",
            indexStatus: nil,
            workTreeStatus: "M"
        )]
    )
    let pushes = AsyncStream<WorkspaceLaneResponse> { continuation in
        continuation.yield(.workspaceList(WorkspaceListPush(workspaces: [
            WorkspaceSummary(id: "w1", name: "Project")
        ])))
        continuation.yield(.ideSnapshot(requestID: nil, state: state))
        continuation.yield(.gitStatus(requestID: nil, result: git))
        continuation.yield(.workspaceChanged(WorkspaceChangedPush(
            workspaceID: "w1",
            generation: 5,
            changedPaths: ["README.md"]
        )))
        continuation.finish()
    }
    let source = WorkspaceIDELaneDataSource(
        request: { request in
            switch request {
            case .files(.listWorkspaces(let requestID)):
                return .files(.workspaces(
                    requestID: requestID,
                    result: WorkspaceListResult(workspaces: [WorkspaceSummary(id: "w1", name: "Project")])
                ))
            case .subscribe(let requestID, _):
                return .ideSnapshot(requestID: requestID, state: state)
            case .gitStatus(let requestID, _):
                return .gitStatus(requestID: requestID, result: git)
            default:
                return .error(WorkspaceLaneError(
                    requestID: request.requestID,
                    code: .invalidRequest
                ))
            }
        },
        events: { pushes }
    )

    #expect(try await source.listWorkspaces() == [WorkspaceSummary(id: "w1", name: "Project")])
    #expect(try await source.subscribe(workspaceID: "w1") == state)
    #expect(try await source.gitStatus(workspaceID: "w1") == git)

    var events: [WorkspaceIDEDataEvent] = []
    for await event in await source.events() { events.append(event) }
    #expect(events == [
        .workspaces([WorkspaceSummary(id: "w1", name: "Project")]),
        .sharedState(state),
        .gitStatus(git),
        .workspaceChanged(WorkspaceChangedPush(
            workspaceID: "w1",
            generation: 5,
            changedPaths: ["README.md"]
        )),
    ])
}
