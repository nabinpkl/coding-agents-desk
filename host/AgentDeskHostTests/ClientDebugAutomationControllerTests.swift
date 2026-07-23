import Foundation
import Testing
import AgentDeskWire
@testable import AgentDeskHost

struct ClientDebugAutomationControllerTests {
    @Test func automationRequestRoundTripsAllOperations() throws {
        for operation in [
            ClientDebugAutomationOperation.screenshot,
            .diagnostics,
            .debugBundle,
        ] {
            let request = ClientDebugAutomationRequest(
                version: 1,
                operation: operation,
                requestId: UUID().uuidString.lowercased(),
                outputDirectory: "/tmp/agentdesk-client-test",
                includePreviousRuns: true,
                maxDiagnosticsBytes: 1,
                maxScreenshotBytes: 2,
                maxPixelDimension: 3
            )
            let data = try JSONEncoder().encode(request)
            #expect(try JSONDecoder().decode(ClientDebugAutomationRequest.self, from: data) == request)
        }
    }

    @Test func outputDirectoryMustBeAClientDebugDirectoryUnderTmp() throws {
        let accepted = try ClientDebugAutomationController.validatedOutputDirectory(
            "/tmp/agentdesk-client-screenshot-test"
        )
        let temporaryRoot = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        #expect(accepted.deletingLastPathComponent().path == temporaryRoot.path)
        #expect(accepted.lastPathComponent == "agentdesk-client-screenshot-test")

        #expect(throws: ClientDebugAutomationError.invalidOutputDirectory) {
            try ClientDebugAutomationController.validatedOutputDirectory("/tmp/unrelated")
        }
        #expect(throws: ClientDebugAutomationError.invalidOutputDirectory) {
            try ClientDebugAutomationController.validatedOutputDirectory("/Users/someone/agentdesk-client-test")
        }
    }

    @MainActor
    @Test func screenshotAutomationConsumesRequestAndWritesResult() async throws {
        let root = URL(fileURLWithPath: "/tmp/agentdesk-client-test-\(UUID().uuidString.lowercased())", isDirectory: true)
        let requestURL = root.appendingPathComponent("request.json")
        let resultURL = root.appendingPathComponent("result.json")
        let outputURL = root
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let requestId = UUID().uuidString.lowercased()
        let request = ClientDebugAutomationRequest(
            version: 1,
            operation: .screenshot,
            requestId: requestId,
            outputDirectory: outputURL.path,
            includePreviousRuns: nil,
            maxDiagnosticsBytes: nil,
            maxScreenshotBytes: 512,
            maxPixelDimension: 128
        )
        try JSONEncoder().encode(request).write(to: requestURL)
        let screenshotRequester = FakeClientScreenshotRequester()
        let controller = ClientDebugAutomationController(
            diagnosticsRequester: FakeClientDiagnosticsRequester(),
            screenshotRequester: screenshotRequester,
            requestURL: requestURL,
            resultURL: resultURL
        )

        await controller.handleRequestFromDisk()

        #expect(!FileManager.default.fileExists(atPath: requestURL.path))
        #expect(screenshotRequester.collectedRequest?.requestId == requestId)
        #expect(FileManager.default.fileExists(atPath: outputURL.appendingPathComponent("client.jpg").path))
        let result = try JSONDecoder().decode(
            ClientDebugAutomationResult.self,
            from: Data(contentsOf: resultURL)
        )
        #expect(result.status == "ok")
        #expect(result.operation == .screenshot)
        #expect(result.screenshotPath == outputURL.appendingPathComponent("client.jpg").path)
        let attributes = try FileManager.default.attributesOfItem(atPath: resultURL.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }
}

@MainActor
private final class FakeClientDiagnosticsRequester: ClientDiagnosticsRequesting {
    func collect(request _: DiagnosticsRequest) async throws -> CollectedClientDiagnostics {
        throw ClientDebugAutomationError.requestUnavailable
    }

    func write(collected _: CollectedClientDiagnostics, to _: URL) throws {}
}

@MainActor
private final class FakeClientScreenshotRequester: ClientScreenshotRequesting {
    private(set) var collectedRequest: ClientScreenshotRequest?

    func collect(request: ClientScreenshotRequest) async throws -> CollectedClientScreenshot {
        collectedRequest = request
        let data = Data([0xFF, 0xD8, 0xFF, 0xD9])
        return CollectedClientScreenshot(
            manifest: ClientScreenshotManifest(
                requestId: request.requestId,
                capturedAt: 1,
                clientBuildSHA: "abc1234",
                surfaceName: "control",
                pixelWidth: 1,
                pixelHeight: 1,
                scale: 1,
                orientation: "portrait",
                mimeType: "image/jpeg",
                totalBytes: data.count,
                sha256: "",
                omittedLayers: []
            ),
            jpegData: data
        )
    }

    func write(_ collected: CollectedClientScreenshot, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try collected.jpegData.write(to: directory.appendingPathComponent("client.jpg"))
    }
}
