import Foundation

/// Binary property-list codec for the authenticated workspace lane. File bytes stay native `Data`
/// inside the envelope, avoiding JSON/base64 expansion while preserving the 101 MiB frame budget.
public enum WorkspaceLaneCodec {
    public static let maximumDocumentBytes = 100 * 1024 * 1024
    public static let maximumFrameBytes = maximumDocumentBytes + 1024 * 1024

    public static func encode(_ request: WorkspaceLaneRequest) throws -> Data {
        try encoder().encode(request)
    }

    public static func encode(_ response: WorkspaceLaneResponse) throws -> Data {
        try encoder().encode(response)
    }

    public static func decodeRequest(_ data: Data) throws -> WorkspaceLaneRequest {
        try PropertyListDecoder().decode(WorkspaceLaneRequest.self, from: data)
    }

    public static func decodeResponse(_ data: Data) throws -> WorkspaceLaneResponse {
        try PropertyListDecoder().decode(WorkspaceLaneResponse.self, from: data)
    }

    private static func encoder() -> PropertyListEncoder {
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        return encoder
    }
}
