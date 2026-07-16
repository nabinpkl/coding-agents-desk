import Foundation

public enum WorkspaceFilesCodec {
    public static let maximumDocumentBytes = 100 * 1024 * 1024
    public static let maximumFrameBytes = maximumDocumentBytes + 1024 * 1024

    public static func encode(_ request: WorkspaceFileRequest) throws -> Data {
        try encoder().encode(request)
    }

    public static func encode(_ response: WorkspaceFileResponse) throws -> Data {
        try encoder().encode(response)
    }

    public static func decodeRequest(_ data: Data) throws -> WorkspaceFileRequest {
        try PropertyListDecoder().decode(WorkspaceFileRequest.self, from: data)
    }

    public static func decodeResponse(_ data: Data) throws -> WorkspaceFileResponse {
        try PropertyListDecoder().decode(WorkspaceFileResponse.self, from: data)
    }

    private static func encoder() -> PropertyListEncoder {
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        return encoder
    }
}
