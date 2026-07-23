import Foundation
import os
import AgentDeskWire

struct CollectedClientDiagnostics {
    let summary: DiagnosticsSummary
    let runPayloads: [String: Data]
}

@MainActor
protocol ClientDiagnosticsRequesting: AnyObject {
    func collect(request: DiagnosticsRequest) async throws -> CollectedClientDiagnostics
    func write(collected: CollectedClientDiagnostics, to directory: URL) throws
}

@MainActor
protocol ClientScreenshotRequesting: AnyObject {
    func collect(request: ClientScreenshotRequest) async throws -> CollectedClientScreenshot
    func write(_ collected: CollectedClientScreenshot, to directory: URL) throws
}

enum ClientDebugAutomationOperation: String, Codable, Sendable {
    case screenshot
    case diagnostics
    case debugBundle = "debug-bundle"
}

struct ClientDebugAutomationRequest: Codable, Equatable, Sendable {
    let version: Int
    let operation: ClientDebugAutomationOperation
    let requestId: String
    let outputDirectory: String
    let includePreviousRuns: Bool?
    let maxDiagnosticsBytes: Int?
    let maxScreenshotBytes: Int?
    let maxPixelDimension: Int?
}

struct ClientDebugAutomationResult: Codable, Equatable, Sendable {
    let version: Int
    let operation: ClientDebugAutomationOperation?
    let requestId: String
    let status: String
    let outputDirectory: String?
    let screenshotPath: String?
    let message: String
}

enum ClientDebugAutomationError: Error, LocalizedError, Equatable {
    case invalidVersion
    case invalidRequestId
    case invalidOutputDirectory
    case requestUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidVersion: "unsupported client debug automation version"
        case .invalidRequestId: "invalid client debug request identifier"
        case .invalidOutputDirectory: "client debug output must be under /tmp"
        case .requestUnavailable: "client debug automation request unavailable"
        }
    }
}

@MainActor
final class ClientDebugAutomationController {
    private let diagnosticsRequester: any ClientDiagnosticsRequesting
    private let screenshotRequester: any ClientScreenshotRequesting
    private let requestURL: URL
    private let resultURL: URL
    private let logger = Logger(subsystem: Config.logSubsystem, category: "client-debug")

    init(
        diagnosticsRequester: any ClientDiagnosticsRequesting,
        screenshotRequester: any ClientScreenshotRequesting,
        requestURL: URL = Config.devClientDebugRequestPath,
        resultURL: URL = Config.devClientDebugResultPath
    ) {
        self.diagnosticsRequester = diagnosticsRequester
        self.screenshotRequester = screenshotRequester
        self.requestURL = requestURL
        self.resultURL = resultURL
    }

    func handleRequestFromDisk() async {
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let requestData: Data?
        if let size = try? requestURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           size > 0,
           size <= Config.clientDebugAutomationRequestMaxBytes {
            let candidate = try? Data(contentsOf: requestURL)
            requestData = candidate.flatMap {
                $0.count <= Config.clientDebugAutomationRequestMaxBytes ? $0 : nil
            }
        } else {
            requestData = nil
        }
        try? FileManager.default.removeItem(at: requestURL)
        let decoded = requestData.flatMap { try? decoder.decode(ClientDebugAutomationRequest.self, from: $0) }
        let requestId = decoded?.requestId ?? UUID().uuidString.lowercased()
        do {
            guard let request = decoded else { throw ClientDebugAutomationError.requestUnavailable }
            guard request.version == 1 else { throw ClientDebugAutomationError.invalidVersion }
            guard UUID(uuidString: request.requestId) != nil else {
                throw ClientDebugAutomationError.invalidRequestId
            }
            let outputURL = try Self.validatedOutputDirectory(request.outputDirectory)
            try? FileManager.default.removeItem(at: resultURL)
            var screenshotPath: String?

            if request.operation == .screenshot || request.operation == .debugBundle {
                let collected = try await screenshotRequester.collect(request: ClientScreenshotRequest(
                    requestId: request.requestId,
                    maxPixelDimension: request.maxPixelDimension,
                    maxBytes: request.maxScreenshotBytes
                ))
                try screenshotRequester.write(collected, to: outputURL)
                screenshotPath = outputURL.appendingPathComponent("client.jpg", isDirectory: false).path
            }
            if request.operation == .diagnostics || request.operation == .debugBundle {
                let collected = try await diagnosticsRequester.collect(request: DiagnosticsRequest(
                    requestId: request.requestId,
                    sinceRunId: nil,
                    includePreviousRuns: request.includePreviousRuns ?? true,
                    maxBytes: request.maxDiagnosticsBytes
                ))
                try diagnosticsRequester.write(collected: collected, to: outputURL)
            }
            let result = ClientDebugAutomationResult(
                version: 1,
                operation: request.operation,
                requestId: request.requestId,
                status: "ok",
                outputDirectory: outputURL.path,
                screenshotPath: screenshotPath,
                message: "client debug artifacts written"
            )
            try write(result, using: encoder)
        } catch {
            let result = ClientDebugAutomationResult(
                version: 1,
                operation: decoded?.operation,
                requestId: requestId,
                status: "error",
                outputDirectory: nil,
                screenshotPath: nil,
                message: error.localizedDescription
            )
            try? write(result, using: encoder)
            logger.error("client debug automation failed operation=\(decoded?.operation.rawValue ?? "unknown", privacy: .public) error=\(String(describing: error), privacy: .public)")
        }
    }

    private func write(_ result: ClientDebugAutomationResult, using encoder: JSONEncoder) throws {
        try FileManager.default.createDirectory(
            at: resultURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try encoder.encode(result).write(to: resultURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: resultURL.path
        )
    }

    nonisolated static func validatedOutputDirectory(_ rawPath: String) throws -> URL {
        let standardized = URL(fileURLWithPath: rawPath, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        let temporaryRoot = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        guard standardized.path.hasPrefix(temporaryRoot.path + "/"),
              standardized.lastPathComponent.hasPrefix("agentdesk-client-") else {
            throw ClientDebugAutomationError.invalidOutputDirectory
        }
        return standardized
    }
}
