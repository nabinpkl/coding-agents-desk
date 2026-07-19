import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct WorkspaceLaneServerTests {
    @Test func decodesRequestDispatchesAndEncodesResponse() async throws {
        let requestID = WorkspaceRequestID(value: "req-1")
        let fileRequest = WorkspaceFileRequest.listWorkspaces(requestID: requestID)
        let request = WorkspaceLaneRequest.files(fileRequest)
        let payload = try WorkspaceLaneCodec.encode(request)
        let expected = WorkspaceLaneResponse.files(.workspaces(
            requestID: requestID,
            result: WorkspaceListResult(workspaces: [WorkspaceSummary(id: "w1", name: "Alpha")])
        ))

        let responsePayload = try await WorkspaceLaneServer.responsePayload(for: payload) { received in
            #expect(received == request)
            return expected
        }

        #expect(try WorkspaceLaneCodec.decodeResponse(responsePayload) == expected)
    }

    @Test func preservesRequestIDForErrorResponses() async throws {
        let requestID = WorkspaceRequestID(value: "req-2")
        let payload = try WorkspaceLaneCodec.encode(
            WorkspaceLaneRequest.files(.read(
                requestID: requestID,
                workspaceID: "missing",
                path: "note.txt"
            ))
        )

        let responsePayload = try await WorkspaceLaneServer.responsePayload(for: payload) { received in
            .files(.error(requestID: received.requestID, error: WorkspaceFileError(code: .notFound)))
        }

        guard case .files(.error(let responseID, _)) = try WorkspaceLaneCodec.decodeResponse(responsePayload) else {
            Issue.record("expected an error response")
            return
        }
        #expect(responseID == requestID)
    }

    @Test func malformedPayloadThrowsAndDoesNotDispatch() async {
        let payload = Data("not a request".utf8)
        await #expect(throws: WorkspaceLaneServerError.malformedRequest) {
            _ = try await WorkspaceLaneServer.responsePayload(for: payload) { _ in
                Issue.record("handler must not run for a malformed payload")
                return .error(WorkspaceLaneError(
                    requestID: WorkspaceRequestID(value: "x"),
                    code: .invalidRequest
                ))
            }
        }
    }
}
