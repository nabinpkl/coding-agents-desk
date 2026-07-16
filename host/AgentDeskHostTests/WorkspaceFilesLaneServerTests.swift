import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct WorkspaceFilesLaneServerTests {
    @Test func decodesRequestDispatchesAndEncodesResponse() async throws {
        let requestID = WorkspaceFileRequestID(value: "req-1")
        let request = WorkspaceFileRequest.listWorkspaces(requestID: requestID)
        let payload = try WorkspaceFilesCodec.encode(request)
        let expected = WorkspaceFileResponse.workspaces(
            requestID: requestID,
            result: WorkspaceListResult(workspaces: [WorkspaceSummary(id: "w1", name: "Alpha")])
        )

        let responsePayload = try await WorkspaceFilesLaneServer.responsePayload(for: payload) { received in
            #expect(received == request)
            return expected
        }

        #expect(try WorkspaceFilesCodec.decodeResponse(responsePayload) == expected)
    }

    @Test func preservesRequestIDForErrorResponses() async throws {
        let requestID = WorkspaceFileRequestID(value: "req-2")
        let payload = try WorkspaceFilesCodec.encode(
            WorkspaceFileRequest.read(requestID: requestID, workspaceID: "missing", path: "note.txt")
        )

        let responsePayload = try await WorkspaceFilesLaneServer.responsePayload(for: payload) { received in
            .error(requestID: received.requestID, error: WorkspaceFileError(code: .notFound))
        }

        guard case .error(let responseID, _) = try WorkspaceFilesCodec.decodeResponse(responsePayload) else {
            Issue.record("expected an error response")
            return
        }
        #expect(responseID == requestID)
    }

    @Test func malformedPayloadThrowsAndDoesNotDispatch() async {
        let payload = Data("not a request".utf8)
        await #expect(throws: WorkspaceFilesLaneError.malformedRequest) {
            _ = try await WorkspaceFilesLaneServer.responsePayload(for: payload) { _ in
                Issue.record("handler must not run for a malformed payload")
                return .error(requestID: WorkspaceFileRequestID(value: "x"), error: WorkspaceFileError(code: .notFound))
            }
        }
    }
}
