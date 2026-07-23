import AVFoundation
import CryptoKit
import UIKit
import WebKit
import AgentDeskWire

struct PreparedClientScreenshot: Sendable {
    let manifest: ClientScreenshotManifest
    let jpegData: Data
}

private struct EncodedClientScreenshot {
    let data: Data
    let pixelWidth: Int
    let pixelHeight: Int
    let scale: CGFloat
}

enum ClientScreenshotCaptureFailure: Error, Equatable {
    case notAuthorized
    case invalidRequest
    case unavailable
    case invalidBounds
    case busy
    case rateLimited
    case renderFailed
    case encodingFailed
    case tooLarge

    var wireReason: String {
        switch self {
        case .notAuthorized: "not-authorized"
        case .invalidRequest: "invalid-request"
        case .unavailable: "capture-unavailable"
        case .invalidBounds: "invalid-bounds"
        case .busy: "capture-busy"
        case .rateLimited: "rate-limited"
        case .renderFailed: "render-failed"
        case .encodingFailed: "encoding-failed"
        case .tooLarge: "screenshot-too-large"
        }
    }
}

@MainActor
final class ClientScreenshotCapturer {
    private var captureInProgress = false
    private var lastCaptureUptime: TimeInterval?

    func capture(
        request: ClientScreenshotRequest,
        window: UIWindow?,
        surfaceName: String,
        authorized: Bool
    ) async throws -> PreparedClientScreenshot {
        guard authorized else { throw ClientScreenshotCaptureFailure.notAuthorized }
        guard request.type == "client-screenshot-request",
              request.requestId.utf8.count <= 64,
              UUID(uuidString: request.requestId) != nil else {
            throw ClientScreenshotCaptureFailure.invalidRequest
        }
        guard !captureInProgress else { throw ClientScreenshotCaptureFailure.busy }
        guard UIApplication.shared.applicationState == .active,
              let window,
              window.windowScene?.activationState == .foregroundActive,
              window.isKeyWindow,
              !window.isHidden else {
            throw ClientScreenshotCaptureFailure.unavailable
        }
        guard window.bounds.width > 0, window.bounds.height > 0 else {
            throw ClientScreenshotCaptureFailure.unavailable
        }

        let now = ProcessInfo.processInfo.systemUptime
        if let lastCaptureUptime,
           now - lastCaptureUptime < Config.screenshotMinimumIntervalSeconds {
            throw ClientScreenshotCaptureFailure.rateLimited
        }
        captureInProgress = true
        defer { captureInProgress = false }

        let requestedDimension = request.maxPixelDimension ?? Config.screenshotMaxPixelDimension
        let requestedBytes = request.maxBytes ?? Config.screenshotMaxBytes
        guard requestedDimension > 0, requestedBytes > 0 else {
            throw ClientScreenshotCaptureFailure.invalidBounds
        }
        let maxDimension = min(requestedDimension, Config.screenshotMaxPixelDimension)
        let maxBytes = min(requestedBytes, Config.screenshotMaxBytes)

        window.layoutIfNeeded()
        CATransaction.flush()
        await Task.yield()

        let targetScale = Self.renderScale(
            bounds: window.bounds,
            screenScale: window.screen.scale,
            maxPixelDimension: maxDimension
        )
        guard targetScale > 0 else { throw ClientScreenshotCaptureFailure.invalidBounds }
        let base = try Self.snapshot(window: window, scale: targetScale)
        let webSnapshots = await Self.snapshotVisibleWebViews(in: window)
        let composed = Self.composite(
            base: base,
            webSnapshots: webSnapshots,
            window: window,
            scale: targetScale
        )
        let encoded = try Self.encodeBoundedJPEG(
            image: composed,
            maxBytes: maxBytes,
            initialQuality: Config.screenshotJPEGQuality,
            pointSize: window.bounds.size
        )
        guard encoded.data.count <= maxBytes else { throw ClientScreenshotCaptureFailure.tooLarge }

        let digest = SHA256.hash(data: encoded.data).map { String(format: "%02x", $0) }.joined()
        let omitted = Self.omittedLayers(in: window)
        let manifest = ClientScreenshotManifest(
            requestId: request.requestId,
            capturedAt: Int(Date().timeIntervalSince1970),
            clientBuildSHA: Bundle.main.object(forInfoDictionaryKey: "AgentDeskGitSHA") as? String ?? "dev",
            surfaceName: surfaceName,
            pixelWidth: encoded.pixelWidth,
            pixelHeight: encoded.pixelHeight,
            scale: Double(encoded.scale),
            orientation: window.windowScene?.interfaceOrientation.isLandscape == true ? "landscape" : "portrait",
            mimeType: "image/jpeg",
            totalBytes: encoded.data.count,
            sha256: digest,
            omittedLayers: omitted
        )
        lastCaptureUptime = now
        return PreparedClientScreenshot(
            manifest: manifest,
            jpegData: encoded.data
        )
    }

    static func makeChunks(data: Data, requestId: String, chunkBytes: Int) -> [ClientScreenshotChunk] {
        guard chunkBytes > 0 else { return [] }
        if data.isEmpty {
            return [ClientScreenshotChunk(requestId: requestId, sequence: 0, isFinal: true, payloadBase64: "")]
        }
        var chunks: [ClientScreenshotChunk] = []
        var offset = 0
        while offset < data.count {
            let end = min(offset + chunkBytes, data.count)
            chunks.append(ClientScreenshotChunk(
                requestId: requestId,
                sequence: chunks.count,
                isFinal: end == data.count,
                payloadBase64: data.subdata(in: offset..<end).base64EncodedString()
            ))
            offset = end
        }
        return chunks
    }

    static func renderScale(bounds: CGRect, screenScale: CGFloat, maxPixelDimension: Int) -> CGFloat {
        guard bounds.width > 0, bounds.height > 0, screenScale > 0, maxPixelDimension > 0 else { return 0 }
        let maximumPointDimension = max(bounds.width, bounds.height)
        return min(screenScale, CGFloat(maxPixelDimension) / maximumPointDimension)
    }

    private static func snapshot(window: UIWindow, scale: CGFloat) throws -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
        var drew = false
        let image = renderer.image { _ in
            drew = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard drew else { throw ClientScreenshotCaptureFailure.renderFailed }
        return image
    }

    private struct WebSnapshot {
        let image: UIImage
        let rect: CGRect
    }

    private static func snapshotVisibleWebViews(in window: UIWindow) async -> [WebSnapshot] {
        var snapshots: [WebSnapshot] = []
        for webView in visibleWebViews(in: window) {
            guard let image = try? await webViewSnapshot(webView) else { continue }
            let rect = webView.convert(webView.bounds, to: window)
            guard rect.width > 0, rect.height > 0, window.bounds.intersects(rect) else { continue }
            snapshots.append(WebSnapshot(image: image, rect: rect))
        }
        return snapshots
    }

    private static func webViewSnapshot(_ webView: WKWebView) async throws -> UIImage {
        try await withCheckedThrowingContinuation { continuation in
            let configuration = WKSnapshotConfiguration()
            configuration.rect = webView.bounds
            webView.takeSnapshot(with: configuration) { image, error in
                if let image {
                    continuation.resume(returning: image)
                } else {
                    continuation.resume(throwing: error ?? ClientScreenshotCaptureFailure.renderFailed)
                }
            }
        }
    }

    private static func visibleWebViews(in root: UIView) -> [WKWebView] {
        guard !root.isHidden, root.alpha > 0.01, root.window != nil else { return [] }
        var result: [WKWebView] = []
        if let webView = root as? WKWebView {
            result.append(webView)
        }
        for subview in root.subviews {
            result.append(contentsOf: visibleWebViews(in: subview))
        }
        return result
    }

    private static func composite(
        base: UIImage,
        webSnapshots: [WebSnapshot],
        window: UIWindow,
        scale: CGFloat
    ) -> UIImage {
        guard !webSnapshots.isEmpty else { return base }
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            base.draw(in: window.bounds)
            for snapshot in webSnapshots {
                snapshot.image.draw(in: snapshot.rect)
            }
        }
    }

    private static func encodeBoundedJPEG(
        image: UIImage,
        maxBytes: Int,
        initialQuality: CGFloat,
        pointSize: CGSize
    ) throws -> EncodedClientScreenshot {
        guard maxBytes > 0 else { throw ClientScreenshotCaptureFailure.invalidBounds }
        var candidate = image
        for _ in 0..<8 {
            for quality in [initialQuality, 0.72, 0.6, 0.48] {
                guard let data = candidate.jpegData(compressionQuality: quality) else {
                    throw ClientScreenshotCaptureFailure.encodingFailed
                }
                if data.count <= maxBytes {
                    let width = candidate.cgImage?.width ?? Int(candidate.size.width * candidate.scale)
                    let height = candidate.cgImage?.height ?? Int(candidate.size.height * candidate.scale)
                    return EncodedClientScreenshot(
                        data: data,
                        pixelWidth: width,
                        pixelHeight: height,
                        scale: pointSize.width > 0 ? CGFloat(width) / pointSize.width : candidate.scale
                    )
                }
            }
            let nextSize = CGSize(width: candidate.size.width * 0.8, height: candidate.size.height * 0.8)
            guard min(nextSize.width, nextSize.height) >= 240 else { break }
            let format = UIGraphicsImageRendererFormat()
            format.scale = candidate.scale
            format.opaque = true
            let source = candidate
            candidate = UIGraphicsImageRenderer(size: nextSize, format: format).image { _ in
                source.draw(in: CGRect(origin: .zero, size: nextSize))
            }
        }
        throw ClientScreenshotCaptureFailure.tooLarge
    }

    private static func omittedLayers(in window: UIWindow) -> [String] {
        var omitted = ["system-keyboard", "system-overlays"]
        if containsSampleBufferDisplayLayer(window.layer) {
            omitted.append("live-video-floor")
        }
        return omitted
    }

    private static func containsSampleBufferDisplayLayer(_ layer: CALayer) -> Bool {
        if layer is AVSampleBufferDisplayLayer { return true }
        return layer.sublayers?.contains(where: containsSampleBufferDisplayLayer) ?? false
    }
}
