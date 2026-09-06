// One picture of one window, on demand.
//
// Deliberately `SCScreenshotManager` rather than an `SCStream`: the note at the top of
// `ControlMode.swift` is that a control helper holding a capture nobody reads is the exact
// condition the encoder's stdout watchdog exists to kill. A screenshot takes a frame and returns,
// so this mode gains a picture without gaining a stream.
//
// The image goes to a file and the reply carries its path, not its bytes. A 1200x800 window is a
// few hundred kilobytes of PNG, and base64 through the NDJSON control channel would double that
// and put it in a frame sized for commands. The sidecar runs as the same user, so it reads the file
// and hands the bytes to whoever asked.

import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// How long to wait for ScreenCaptureKit. Verbs answer synchronously on the command reader, so this
/// blocks it; a capture that has not happened in this long is not going to.
private let captureTimeout: DispatchTimeInterval = .seconds(10)

func registerWindowCaptureVerbs(on control: ControlMode) {
    control.register("window-shot") { request in
        guard let windowID = (request["windowID"] as? NSNumber)?.uint32Value, windowID != 0 else {
            return .failure("no-window")
        }
        guard DesktopAudit.screenRecordingTrusted else { return .failure("capture-denied") }
        // Scaled down on request, because the point is usually to see what a window is showing
        // rather than to read it: a 1200pt window at 480 wide is a tenth of the bytes.
        let maxWidth = (request["maxWidth"] as? NSNumber)?.intValue
        return WindowCapture.shot(windowID: windowID, maxWidth: maxWidth)
    }
}

enum WindowCapture {
    static func shot(windowID: CGWindowID, maxWidth: Int?) -> ControlMode.Outcome {
        guard #available(macOS 14.0, *) else { return .failure("capture-denied") }
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: ControlMode.Outcome = .failure("write-failed")
        Task {
            defer { semaphore.signal() }
            do {
                // `onScreenWindowsOnly: false` so a window that is behind another, or on a Space
                // that is not showing, is still capturable. On this desk that is the normal case:
                // the whole point of the wall is windows nobody is looking at directly.
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: false)
                guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                    outcome = .failure("no-window")
                    return
                }
                let configuration = SCStreamConfiguration()
                let (width, height) = scaled(window.frame.size, maxWidth: maxWidth)
                configuration.width = width
                configuration.height = height
                configuration.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: SCContentFilter(desktopIndependentWindow: window),
                    configuration: configuration)
                guard let path = write(image) else {
                    outcome = .failure("write-failed")
                    return
                }
                outcome = .ok([
                    "windowID": Int(windowID),
                    "path": path,
                    "width": image.width,
                    "height": image.height,
                    "title": window.title ?? "",
                    "app": window.owningApplication?.applicationName ?? "",
                ])
            } catch {
                outcome = .failure("write-failed")
            }
        }
        if semaphore.wait(timeout: .now() + captureTimeout) == .timedOut {
            return .failure("write-failed")
        }
        return outcome
    }

    /// Never larger than the window itself: scaling a capture up spends bytes on nothing.
    private static func scaled(_ size: CGSize, maxWidth: Int?) -> (Int, Int) {
        let width = max(1, Int(size.width.rounded()))
        let height = max(1, Int(size.height.rounded()))
        guard let maxWidth, maxWidth > 0, width > maxWidth else { return (width, height) }
        return (maxWidth, max(1, Int((Double(maxWidth) / Double(width) * Double(height)).rounded())))
    }

    private static func write(_ image: CGImage) -> String? {
        let name = "window-shot-\(UUID().uuidString).png"
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent(name)
        guard let destination = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? path : nil
    }
}
