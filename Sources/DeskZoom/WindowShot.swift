import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// A picture of one window, by window id, written as PNG. A script reads what it did from this rather
/// than from a screenshot of the screen, which would record everything else the user has open.
enum WindowShot {
    static func capture(windowID: CGWindowID, pixelsPerPoint: CGFloat, to file: URL) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            throw DeskZoomError.windowGone(windowID)
        }
        let configuration = SCStreamConfiguration()
        configuration.width = Int(window.frame.width * pixelsPerPoint)
        configuration.height = Int(window.frame.height * pixelsPerPoint)
        configuration.showsCursor = false
        configuration.captureResolution = .best
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration)
        guard let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw DeskZoomError.shotNotWritten(file.path)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw DeskZoomError.shotNotWritten(file.path) }
    }
}
