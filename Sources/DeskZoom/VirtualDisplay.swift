import CGVirtualDisplayPrivate
import CoreGraphics
import Foundation

enum DeskZoomError: Error, CustomStringConvertible {
    case virtualDisplayRejected(width: Int, height: Int)
    case virtualDisplayNeverAppeared(CGDirectDisplayID)
    case modeMissing(width: Int, height: Int)
    case modeChangeFailed(CGError)
    case captureDisplayNotShareable(CGDirectDisplayID)
    case captureStopped(Error)

    var description: String {
        switch self {
        case let .virtualDisplayRejected(w, h):
            return "CoreGraphics rejected the \(w)x\(h) virtual display mode."
        case let .virtualDisplayNeverAppeared(id):
            return "Virtual display \(id) was created but never showed up in NSScreen.screens."
        case let .modeMissing(w, h):
            return "The virtual display came online without a \(w)x\(h) mode."
        case let .modeChangeFailed(code):
            return "Switching the virtual display mode failed with CGError \(code.rawValue)."
        case let .captureDisplayNotShareable(id):
            return "ScreenCaptureKit does not list display \(id). Screen Recording permission missing?"
        case let .captureStopped(err):
            return "Capture stream stopped: \(err)"
        }
    }
}

/// Owns one virtual display for the app's lifetime. Deallocating it removes the display.
final class VirtualDisplay {
    let displayID: CGDirectDisplayID
    /// The canvas in points: what windows are laid out in, and what everything else here measures.
    private(set) var size: CGSize
    /// Framebuffer pixels per point, read from the mode the display actually adopted rather than assumed.
    /// This is the ceiling on how sharp a capture of it can ever be.
    private(set) var pixelsPerPoint: CGFloat
    private let pixelSize: CGSize
    private var wantsHiDPI = false
    private let display: CGVirtualDisplay

    /// `width` and `height` are framebuffer pixels, which is what the hardware caps. With `hiDPI` the canvas
    /// is half that in points and text renders at two pixels per point; without it the canvas is the full
    /// size at one. Points and detail come out of the same budget.
    init(width: Int, height: Int, hiDPI: Bool, name: String) throws {
        let descriptor = CGVirtualDisplayDescriptor()
        descriptor.setDispatchQueue(.main)
        descriptor.name = name
        descriptor.maxPixelsWide = UInt32(width)
        descriptor.maxPixelsHigh = UInt32(height)
        // Physical size only feeds the reported DPI; at 1x it does not change layout.
        descriptor.sizeInMillimeters = CGSize(width: 1600, height: 1000)
        descriptor.productID = 0x445A
        descriptor.vendorID = 0x445A
        descriptor.serialNum = 1
        descriptor.terminationHandler = { _, _ in
            FileHandle.standardError.write("virtual display terminated by the system\n".data(using: .utf8)!)
        }

        let display = CGVirtualDisplay(descriptor: descriptor)
        let settings = CGVirtualDisplaySettings()
        self.wantsHiDPI = hiDPI
        // A HiDPI mode is a *pair*: macOS makes one only when it is given both the pixel-size mode and the
        // point-size mode that is exactly half of it. Declaring one mode and setting the flag produces a
        // plain 1x display, which is what an earlier attempt measured and wrongly concluded from.
        settings.hiDPI = hiDPI ? 1 : 0
        settings.modes = hiDPI
            ? [
                CGVirtualDisplayMode(width: UInt(width), height: UInt(height), refreshRate: 60),
                CGVirtualDisplayMode(width: UInt(width / 2), height: UInt(height / 2), refreshRate: 60),
            ]
            : [CGVirtualDisplayMode(width: UInt(width), height: UInt(height), refreshRate: 60)]
        guard display.apply(settings) else {
            throw DeskZoomError.virtualDisplayRejected(width: width, height: height)
        }

        self.display = display
        self.displayID = display.displayID
        self.pixelSize = CGSize(width: width, height: height)
        // Provisional until the display is online and its real mode can be read.
        self.size = CGSize(width: width, height: height)
        self.pixelsPerPoint = 1
    }

    /// macOS 26 brings the display up at a default it picks itself (1920x1200 observed), even when only
    /// one mode was declared. Select the declared mode explicitly. Returns immediately if already active.
    func selectDeclaredMode() throws {
        let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
        let width = Int(pixelSize.width), height = Int(pixelSize.height)
        // Both the 1x and the HiDPI mode report the same pixel size; they differ in how many points those
        // pixels are spread over, so the point width is what tells them apart.
        let candidates = (CGDisplayCopyAllDisplayModes(displayID, options) as? [CGDisplayMode] ?? [])
            .filter { $0.pixelWidth == width && $0.pixelHeight == height }
        guard let mode = wantsHiDPI ? candidates.min(by: { $0.width < $1.width })
                                    : candidates.max(by: { $0.width < $1.width })
        else { throw DeskZoomError.modeMissing(width: width, height: height) }
        adopt(mode)
        if let current = CGDisplayCopyDisplayMode(displayID),
           current.pixelWidth == width, current.pixelHeight == height, current.width == mode.width {
            return
        }
        var configuration: CGDisplayConfigRef?
        var status = CGBeginDisplayConfiguration(&configuration)
        guard status == .success, let configuration else { throw DeskZoomError.modeChangeFailed(status) }
        status = CGConfigureDisplayWithDisplayMode(configuration, displayID, mode, nil)
        guard status == .success else {
            CGCancelDisplayConfiguration(configuration)
            throw DeskZoomError.modeChangeFailed(status)
        }
        status = CGCompleteDisplayConfiguration(configuration, .forSession)
        guard status == .success else { throw DeskZoomError.modeChangeFailed(status) }
    }

    /// The mode is the authority on how the display is measured, not what was asked for.
    private func adopt(_ mode: CGDisplayMode) {
        size = CGSize(width: mode.width, height: mode.height)
        pixelsPerPoint = mode.width > 0 ? CGFloat(mode.pixelWidth) / CGFloat(mode.width) : 1
    }
}
