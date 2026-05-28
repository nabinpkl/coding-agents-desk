import Foundation

// POSTs an in-memory WAV clip to the host-local transcription service as
// multipart/form-data (field name "file") and returns the recognised text.
// First and only outbound HTTP path on the host; everything else is the
// Tailscale WebSocket plane.
struct TranscriptionClient {
    enum TranscriptionError: Error {
        case badStatus(Int)
        case malformedResponse
        case emptyTranscript
    }

    private let endpoint: URL
    private let session: URLSession

    init(endpoint: URL = Config.transcriptionEndpoint, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.session = session
    }

    func transcribe(wav: Data) async throws -> String {
        let boundary = "AgentDesk-\(UUID().uuidString)"
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.appendUTF8("--\(boundary)\r\n")
        body.appendUTF8("Content-Disposition: form-data; name=\"file\"; filename=\"clip.wav\"\r\n")
        body.appendUTF8("Content-Type: audio/wav\r\n\r\n")
        body.append(wav)
        body.appendUTF8("\r\n--\(boundary)--\r\n")

        let (data, response) = try await session.upload(for: request, from: body)
        guard let http = response as? HTTPURLResponse else {
            throw TranscriptionError.malformedResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw TranscriptionError.badStatus(http.statusCode)
        }
        guard let decoded = try? JSONDecoder().decode(TranscriptionResponse.self, from: data) else {
            throw TranscriptionError.malformedResponse
        }
        let text = decoded.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw TranscriptionError.emptyTranscript }
        return text
    }
}

private struct TranscriptionResponse: Decodable {
    let text: String
}

private extension Data {
    mutating func appendUTF8(_ string: String) {
        append(contentsOf: string.utf8)
    }
}
