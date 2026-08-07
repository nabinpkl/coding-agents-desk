import AppKit
import CoreGraphics
import CryptoKit
import ScreenCaptureKit
import os
import AgentDeskWire

// Source for the phone's window picker.
//
// Capture-free by design. It enumerates windows and asks SkyLight which Space each sits on,
// which measured at roughly 18 ms CPU per call against 182 windows -- about a hundredth of
// the cost class of the thumbnail capture path. That is why it can run on demand without the
// background timer that made thumbnails a CPU line item, and it refreshes only when the
// picker asks or the active Space changes.
//
// `onScreenWindowsOnly: false` is load-bearing. The windows most worth watching from a phone
// are the ones on another Desktop, and `true` filters exactly those out.
final class WindowListProvider: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "window-list")
    private let sky: SkyLightThumbnailBinding?
    private struct CachedIcon {
        let hash: String
        let base64: String
    }
    // bundle id -> rendered icon, for the lifetime of the process. Bounded by distinct app
    // count (single digits to low double digits), not window count, because icons are per-app.
    // The hash is cached with the bytes: it is derived from them and never changes, and a
    // snapshot touches every window, so re-hashing per hit would run SHA256 over a megabyte of
    // PNG to learn nothing.
    private let iconCache = OSAllocatedUnfairLock(initialState: [String: CachedIcon]())

    struct Snapshot: Sendable {
        let windows: [WindowSummary]
        // Every icon referenced by `windows`, keyed by hash. The per-client send filter
        // lives at the push site, which is the only thing that knows what a client has.
        let icons: [String: String]
    }

    init(skylight: SkyLightThumbnailBinding? = .shared) {
        self.sky = skylight
    }

    func snapshot() async -> Snapshot {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
        } catch {
            logger.error("window list enumeration failed: \(String(describing: error), privacy: .public)")
            return Snapshot(windows: [], icons: [:])
        }

        var summaries: [WindowSummary] = []
        var icons: [String: String] = [:]
        for window in CaptureWindowFilter.candidates(content) {
            guard let app = window.owningApplication else { continue }
            let windowID = CGWindowID(window.windowID)
            guard let iconHash = iconHash(forBundleId: app.bundleIdentifier, into: &icons) else { continue }
            summaries.append(WindowSummary(
                id: UInt32(windowID),
                spaceId: sky?.firstSpaceContaining(windowID: windowID),
                appName: app.applicationName,
                title: window.title ?? "",
                iconHash: iconHash
            ))
        }
        // Space then app then title, so windows of one Desktop stay adjacent in the flat
        // strip without spending a row on a per-Desktop header. Unplaced windows sort last.
        summaries.sort { lhs, rhs in
            if lhs.spaceId != rhs.spaceId {
                return (lhs.spaceId ?? .max) < (rhs.spaceId ?? .max)
            }
            if lhs.appName != rhs.appName { return lhs.appName < rhs.appName }
            return lhs.title < rhs.title
        }
        logger.debug("window list windows=\(summaries.count, privacy: .public) icons=\(icons.count, privacy: .public)")
        return Snapshot(windows: summaries, icons: icons)
    }

    // Everything the host needs to switch to a window and drive it, resolved fresh at selection
    // time rather than trusted from the client. The phone only ever sends a window id; the pid
    // and rect behind it are the host's own business, and a stale pid from an app that has
    // since restarted would aim Accessibility calls at the wrong process.
    //
    // `displayIdForSpace` closes the last gap: SkyLight answers which Space a window sits on,
    // but the focus path needs the display that Space belongs to, and DesktopState is the only
    // thing that knows.
    func resolveWatchedWindow(
        id: CGWindowID,
        displayIdForSpace: @Sendable (UInt64) -> String?
    ) async -> WatchedWindow? {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
        } catch {
            logger.error("window resolve enumeration failed: \(String(describing: error), privacy: .public)")
            return nil
        }
        guard let window = content.windows.first(where: { CGWindowID($0.windowID) == id }),
              let app = window.owningApplication else {
            logger.notice("window resolve found no window wid=\(id, privacy: .public)")
            return nil
        }
        let spaceId = sky?.firstSpaceContaining(windowID: id)
        return WatchedWindow(
            id: id,
            pid: app.processID,
            spaceId: spaceId,
            displayId: spaceId.flatMap(displayIdForSpace),
            bounds: window.frame,
            title: window.title ?? "",
            appName: app.applicationName
        )
    }

    // Renders each app's icon once per process, then answers from cache. Returns nil when the
    // icon cannot be produced, which drops the window from the picker rather than offering a
    // blank tile the user cannot identify.
    private func iconHash(forBundleId bundleId: String, into icons: inout [String: String]) -> String? {
        if let cached = iconCache.withLock({ $0[bundleId] }) {
            icons[cached.hash] = cached.base64
            return cached.hash
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return nil }
        let image = NSWorkspace.shared.icon(forFile: url.path)
        guard let base64 = Self.pngBase64(image) else { return nil }
        let cached = CachedIcon(hash: Self.hash(base64), base64: base64)
        iconCache.withLock { $0[bundleId] = cached }
        icons[cached.hash] = cached.base64
        return cached.hash
    }

    // 64pt at 2x. Large enough for a Retina strip icon, small enough that a dozen of them
    // ride a config-sized push without needing their own transfer path.
    private static let iconPixelSize = 128

    private static func pngBase64(_ image: NSImage) -> String? {
        let size = NSSize(width: iconPixelSize, height: iconPixelSize)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: iconPixelSize,
            pixelsHigh: iconPixelSize,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return png.base64EncodedString()
    }

    private static func hash(_ base64: String) -> String {
        SHA256.hash(data: Data(base64.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
