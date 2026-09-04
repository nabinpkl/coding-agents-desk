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
    private let display: CGVirtualDisplay
    /// Every canvas the display can be switched to at runtime, widest points last.
    private(set) var ladder: [Canvas] = []

    /// One rung: a canvas size in points and how much detail backs it.
    struct Canvas: Equatable {
        let size: CGSize
        let pixelsPerPoint: CGFloat
        var label: String { "\(Int(size.width))×\(Int(size.height)) @\(Int(pixelsPerPoint))x" }
    }

    /// `width` and `height` are the largest framebuffer to ask for, which is what the hardware caps.
    /// A ladder of canvases is declared underneath it, and the display can be moved between them while
    /// running: small canvases are backed at two pixels per point, large ones at one, because points and
    /// detail come out of the same framebuffer budget.
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
        // A HiDPI mode is a *pair*: macOS makes one only when it is given both the pixel-size mode and the
        // point-size mode that is exactly half of it. Declaring one mode and setting the flag produces a
        // plain 1x display, which is what an earlier attempt measured and wrongly concluded from.
        // So the framebuffer sizes below are declared as a set, and macOS pairs each with its half.
        settings.hiDPI = 1
        settings.modes = Self.declaredPixelSizes(maxWidth: width, maxHeight: height).map {
            CGVirtualDisplayMode(width: UInt($0.width), height: UInt($0.height), refreshRate: 60)
        }
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

    /// Framebuffer sizes to declare, as fractions of the largest asked for. Halves are included so macOS can
    /// pair them into HiDPI modes, which is what puts sharp rungs at the small end of the ladder.
    static func declaredPixelSizes(maxWidth: Int, maxHeight: Int) -> [CGSize] {
        let fractions: [Double] = [0.25, 1.0 / 3, 0.5, 2.0 / 3, 0.8, 1.0]
        var sizes: Set<CGSize> = []
        for fraction in fractions {
            let width = (Double(maxWidth) * fraction / 2).rounded() * 2
            let height = (Double(maxHeight) * fraction / 2).rounded() * 2
            guard width >= 640 else { continue }
            sizes.insert(CGSize(width: width, height: height))
            let doubled = CGSize(width: width * 2, height: height * 2)
            if Int(doubled.width) <= maxWidth { sizes.insert(doubled) }
        }
        return sizes.sorted { $0.width < $1.width }
    }

    /// A canvas the display offers, before the ladder decides whether to keep it.
    struct Rung: Equatable {
        let width: Int
        let height: Int
        let pixelWidth: Int
    }

    /// The rungs worth offering, one per canvas size, each backed by the sharpest mode available for it.
    ///
    /// A virtual display always advertises a pile of small legacy modes of its own, including 4:3 ones.
    /// Those are not desks: a 1024x640 canvas holds nothing, and a canvas of a different shape would not
    /// even fit the viewer. So the list is filtered to the requested shape and to sizes worth switching to.
    static func ladder(from rungs: [Rung], aspect: CGFloat, minimumWidth: Int) -> [Canvas] {
        var best: [Int: Rung] = [:]
        for rung in rungs {
            guard rung.width >= minimumWidth, rung.height > 0 else { continue }
            let shape = CGFloat(rung.width) / CGFloat(rung.height)
            guard abs(shape - aspect) <= aspect * 0.01 else { continue }
            if let existing = best[rung.width], existing.pixelWidth >= rung.pixelWidth { continue }
            best[rung.width] = rung
        }
        return best.values
            .sorted { $0.width < $1.width }
            .map { Canvas(size: CGSize(width: $0.width, height: $0.height),
                          pixelsPerPoint: CGFloat($0.pixelWidth) / CGFloat($0.width)) }
    }

    /// macOS 26 brings the display up at a default it picks itself (1920x1200 observed), even when only
    /// one mode was declared. Select the declared mode explicitly. Returns immediately if already active.
    func selectDeclaredMode() throws {
        let rungs = availableModes()
            .filter { $0.isUsableForDesktopGUI() }
            .map { Rung(width: $0.width, height: $0.height, pixelWidth: $0.pixelWidth) }
        ladder = Self.ladder(
            from: rungs,
            aspect: pixelSize.width / pixelSize.height,
            // Anything under a quarter of the framebuffer is too small to be a desk worth switching to.
            minimumWidth: Int(pixelSize.width) / 4
        )
        guard let widest = ladder.last else {
            throw DeskZoomError.modeMissing(width: Int(pixelSize.width), height: Int(pixelSize.height))
        }
        try select(canvas: widest)
    }

    /// Switches the running display to another rung. The windows on it are rearranged by macOS, and the
    /// canvas is measured in points, so every caller has to re-read `size` afterwards.
    func select(canvas: Canvas) throws {
        guard let mode = availableModes().first(where: {
            CGFloat($0.width) == canvas.size.width
                && CGFloat($0.height) == canvas.size.height
                && CGFloat($0.pixelWidth) / CGFloat($0.width) == canvas.pixelsPerPoint
        }) else {
            throw DeskZoomError.modeMissing(width: Int(canvas.size.width), height: Int(canvas.size.height))
        }
        adopt(mode)
        if let current = CGDisplayCopyDisplayMode(displayID),
           current.width == mode.width, current.pixelWidth == mode.pixelWidth {
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

    private func availableModes() -> [CGDisplayMode] {
        let options = [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary
        return CGDisplayCopyAllDisplayModes(displayID, options) as? [CGDisplayMode] ?? []
    }

    /// The mode is the authority on how the display is measured, not what was asked for.
    private func adopt(_ mode: CGDisplayMode) {
        size = CGSize(width: mode.width, height: mode.height)
        pixelsPerPoint = mode.width > 0 ? CGFloat(mode.pixelWidth) / CGFloat(mode.width) : 1
    }
}
