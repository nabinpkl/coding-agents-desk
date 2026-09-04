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
    let size: CGSize
    private let display: CGVirtualDisplay

    init(width: Int, height: Int, name: String) throws {
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
        settings.hiDPI = 0
        settings.modes = [CGVirtualDisplayMode(width: UInt(width), height: UInt(height), refreshRate: 60)]
        guard display.apply(settings) else {
            throw DeskZoomError.virtualDisplayRejected(width: width, height: height)
        }

        self.display = display
        self.displayID = display.displayID
        self.size = CGSize(width: width, height: height)
    }

    /// macOS 26 brings the display up at a default it picks itself (1920x1200 observed), even when only
    /// one mode was declared. Select the declared mode explicitly. Returns immediately if already active.
    func selectDeclaredMode() throws {
        let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
        let width = Int(size.width), height = Int(size.height)
        guard let modes = CGDisplayCopyAllDisplayModes(displayID, options) as? [CGDisplayMode],
              let mode = modes.first(where: { $0.width == width && $0.height == height })
        else { throw DeskZoomError.modeMissing(width: width, height: height) }
        if let current = CGDisplayCopyDisplayMode(displayID), current.width == width, current.height == height {
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
}
