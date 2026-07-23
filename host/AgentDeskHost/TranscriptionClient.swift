import Foundation

// POSTs an in-memory WAV clip to the host-local transcription service as
// multipart/form-data (field name "file") and returns the recognised text.
// First and only outbound HTTP path on the host; live sessions use the
// Tailscale QUIC session plane.
struct TranscriptionClient {
    enum TranscriptionError: Error {
        case notConfigured
        case badStatus(Int)
        case malformedResponse
        case emptyTranscript
    }

    private let endpoint: URL?
    private let model: String
    private let session: URLSession

    init(
        endpoint: URL? = Config.transcriptionEndpoint,
        model: String = Config.transcriptionModel,
        session: URLSession = .shared
    ) {
        self.endpoint = endpoint
        self.model = model
        self.session = session
    }

    func transcribe(wav: Data) async throws -> String {
        // Dictation posts to the host-owned voice sidecar's OpenAI-compatible
        // endpoint (Config.transcriptionEndpoint defaults to its loopback URL).
        // A nil endpoint fails here rather than POSTing at a host that may not
        // exist.
        guard let endpoint else { throw TranscriptionError.notConfigured }
        let boundary = "AgentDesk-\(UUID().uuidString)"
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.appendUTF8("--\(boundary)\r\n")
        body.appendUTF8("Content-Disposition: form-data; name=\"model\"\r\n\r\n")
        body.appendUTF8(model)
        body.appendUTF8("\r\n--\(boundary)\r\n")
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
