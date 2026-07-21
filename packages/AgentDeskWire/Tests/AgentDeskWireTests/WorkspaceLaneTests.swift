import Foundation
import Testing
@testable import AgentDeskWire

private func laneRoundTrip<T: Codable & Equatable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    #expect(try JSONDecoder().decode(T.self, from: data) == value)
}

@Test func workspaceLaneRequestsRoundTripEveryVariant() throws {
    let requestID = WorkspaceRequestID(value: "request-1")
    let stateRevision: UInt64 = 8
    let operationID = WorkspaceIDEOperationID(value: "operation-1")
    let requests: [WorkspaceLaneRequest] = [
        .files(.read(requestID: requestID, workspaceID: "w1", path: "Report.docx")),
        .subscribe(requestID: requestID, workspaceID: "w1"),
        .unsubscribe(requestID: requestID, workspaceID: "w1"),
        .operation(
            requestID: requestID,
            workspaceID: "w1",
            baseRevision: stateRevision,
            operationID: operationID,
            operation: .reorder(orderedPaths: ["Sources/App.swift", "README.md"])
        ),
        .gitStatus(requestID: requestID, workspaceID: "w1"),
    ]

    for request in requests {
        let payload = try WorkspaceLaneCodec.encode(request)
        #expect(payload.starts(with: Data("bplist".utf8)))
        #expect(try WorkspaceLaneCodec.decodeRequest(payload) == request)
        #expect(request.requestID == requestID)
    }
}

@Test func workspaceLaneResponsesRoundTripCorrelatedAndPushVariants() throws {
    let requestID = WorkspaceRequestID(value: "request-1")
    let state = WorkspaceIDESharedState(
        workspaceID: "w1",
        revision: 9,
        orderedOpenPaths: ["README.md"],
        expandedDirectoryPaths: ["Sources"]
    )
    let git = WorkspaceGitStatusResult(
        workspaceID: "w1",
        generation: 4,
        entries: [WorkspaceGitStatusEntry(relativePath: "README.md", indexStatus: "M", workTreeStatus: nil)]
    )
    let responses: [WorkspaceLaneResponse] = [
        .files(.error(
            requestID: requestID,
            error: WorkspaceFileError(code: .notFound)
        )),
        .ideSnapshot(requestID: requestID, state: state),
        .ideSnapshot(requestID: nil, state: state),
        .gitStatus(requestID: requestID, result: git),
        .gitStatus(requestID: nil, result: git),
        .workspaceChanged(WorkspaceChangedPush(
            workspaceID: "w1",
            generation: 5,
            changedPaths: ["README.md", "Sources/App.swift"]
        )),
        .workspaceList(WorkspaceListPush(workspaces: [
            WorkspaceSummary(
                id: "w1",
                name: "Alpha",
                desktopOrdinal: 3,
                desktopAutoAssignEnabled: true
            ),
            WorkspaceSummary(id: "w2", name: "Beta"),
        ])),
        .error(WorkspaceLaneError(
            requestID: requestID,
            workspaceID: "w1",
            code: .revisionConflict,
            message: "Shared workspace state changed."
        )),
    ]

    for response in responses {
        let payload = try WorkspaceLaneCodec.encode(response)
        #expect(try WorkspaceLaneCodec.decodeResponse(payload) == response)
    }
    #expect(responses[0].requestID == requestID)
    #expect(responses[1].requestID == requestID)
    #expect(responses[2].requestID == nil)
    #expect(responses[5].requestID == nil)
    #expect(responses[6].requestID == nil)
}

@Test func workspaceIDEOperationsRoundTripEveryVariant() throws {
    let operations: [WorkspaceIDEOperation] = [
        .open(path: "README.md"),
        .close(path: "README.md"),
        .reorder(orderedPaths: ["README.md", "Sources/App.swift"]),
        .expand(path: "Sources"),
        .collapse(path: "Sources"),
    ]
    for operation in operations { try laneRoundTrip(operation) }
}

@Test func workspaceLaneKeepsDocumentBytesNativeAtTheConfiguredBoundary() throws {
    #expect(WorkspaceLaneCodec.maximumDocumentBytes == 100 * 1024 * 1024)
    #expect(WorkspaceLaneCodec.maximumFrameBytes == 101 * 1024 * 1024)

    let bytes = Data(repeating: 0xa5, count: WorkspaceLaneCodec.maximumDocumentBytes)
    let response = WorkspaceLaneResponse.files(.read(
        requestID: WorkspaceRequestID(value: "docx"),
        result: WorkspaceFileReadResult(
            workspaceID: "w1",
            path: "Report.docx",
            content: .document(bytes),
            revision: WorkspaceFileRevision(digest: "sha256:docx")
        )
    ))
    let encoded = try WorkspaceLaneCodec.encode(response)
    guard case .files(.read(_, let result)) = try WorkspaceLaneCodec.decodeResponse(encoded) else {
        Issue.record("expected a native document response")
        return
    }
    #expect(encoded.count <= WorkspaceLaneCodec.maximumFrameBytes)
    #expect(result.document == bytes)
}

@Test func remoteBrowserProjectionProtocolVersionTwelveIsPinned() {
    #expect(WireProtocol.version == 12)
    #expect(WireProtocol.minCompatibleVersion == 12)
    #expect(10 < WireProtocol.minCompatibleVersion)
}
