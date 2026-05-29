import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import os

// R20 / ADR-0006 thumbnail capture pipeline.
//
// Responsibility: for each non-active user Space, produce a JPEG
// thumbnail composited from the windows that live on that Space. Emits
// the latest set as `[UInt64: Data]` on `thumbnails` whenever it
// recomputes (3 s timer + NSWorkspace.activeSpaceDidChangeNotification
// + explicit forceRefresh). Last-good results are retained while capture
// demand is off so reopening a surface can render stale thumbnails
// immediately, then replace them when the next capture completes.
//
// Toggleable via owner-scoped demand: when no owner needs thumbnails,
// the timer and the observer stop and the stream stops emitting. The
// host pays zero capture cost when no surface has asked for thumbnails.
//
// Resolves its own SkyLight symbol for `SLSCopySpacesForWindows`; does
// not widen SpacesProvider's struct so a single private surface failure
// here cannot break Spaces enumeration / switching.

enum SpaceThumbnailDemandOwner: Hashable, Sendable {
    case spaceAgent
    case client(String)
}

// SpaceTopWindow now lives in SharedTypes.swift so it can ride along the
// thumbnails-push wire shape into the iOS client and feed the same
// labelling logic on both sides.

final class SpaceThumbnailProvider: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "thumbnails")

    // 3 s refresh cadence per ADR-0006. Knob is local to this file; if
    // thumbnails feel stale, lower this. The wire shape doesn't change.
    static let refreshInterval: TimeInterval = 3.0

    // ADR-0006 size and quality. Bitmap dimensions are kept above the
    // 128 x 80 point tile size so the SpaceAgent strip draws crisp on
    // 2x / 3x Retina displays; JPEG quality is high enough that window
    // chrome and text stay legible when scaled down to thumbnail size.
    static let thumbnailWidth: Int = 384
    static let thumbnailHeight: Int = 240
    static let jpegQuality: Double = 0.85

    // Capture cap so a workstation with dozens of windows doesn't pin
    // the CPU. Top-N by area, biased toward "the window the user cares
    // about" without per-app heuristics in v0.
    static let maxWindowsPerSpace: Int = 6

    var thumbnails: AsyncStream<[UInt64: Data]> {
        AsyncStream { continuation in
            let id = UUID()
            let latest = state.withLock { s -> [UInt64: Data]? in
                s.continuations[id] = continuation
                return s.latest
            }
            if let latest {
                continuation.yield(latest)
            }
            continuation.onTermination = { [state] _ in
                state.withLock { $0.continuations[id] = nil }
            }
        }
    }

    // State held under an OSAllocatedUnfairLock so the scheduling
    // decision can be read+modified atomically from both sync (setDemand,
    // installSpaceChangeObserver callback) and async (Task.detached
    // capture pipeline) contexts. NSLock is unavailable in async on
    // Swift 6; this is the recommended replacement.
    private struct State {
        var demandOwners: Set<SpaceThumbnailDemandOwner> = []
        var capturing: Bool = false
        var pendingForceRefreshSpaceId: UInt64?
        var latest: [UInt64: Data]?
        var latestTopWindows: [UInt64: SpaceTopWindow] = [:]
        var continuations: [UUID: AsyncStream<[UInt64: Data]>.Continuation] = [:]
    }
    private let state = OSAllocatedUnfairLock<State>(initialState: State())

    /// Cached top-window metadata for each Space, updated atomically with
    /// the thumbnails on every capture tick. Callers read this when they
    /// receive a new value from the `thumbnails` stream so labels and
    /// images stay in lockstep without needing a second async stream.
    var latestTopWindows: [UInt64: SpaceTopWindow] {
        state.withLock { $0.latestTopWindows }
    }

    private var refreshTask: Task<Void, Never>?
    private var spaceChangeObserver: NSObjectProtocol?
    private let sky: SkyLightThumbnailBinding?
    private let captureOverride: (@Sendable () async -> CaptureResult)?

    init(
        skylight: SkyLightThumbnailBinding? = SkyLightThumbnailBinding.shared,
        captureOverride: (@Sendable () async -> CaptureResult)? = nil
    ) {
        self.sky = skylight
        self.captureOverride = captureOverride
        if skylight == nil {
            logger.error("SLSCopySpacesForWindows not resolvable; thumbnails will be empty")
        }
    }

    deinit {
        if let observer = spaceChangeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        refreshTask?.cancel()
        let continuations = state.withLock { s -> [AsyncStream<[UInt64: Data]>.Continuation] in
            let values = Array(s.continuations.values)
            s.continuations.removeAll()
            return values
        }
        for continuation in continuations {
            continuation.finish()
        }
    }

    // MARK: - Public surface

    var hasActiveDemand: Bool {
        state.withLock { !$0.demandOwners.isEmpty }
    }

    func setDemand(owner: SpaceThumbnailDemandOwner, enabled: Bool) {
        let transition = state.withLock { s -> (wasEnabled: Bool, isEnabled: Bool) in
            let wasEnabled = !s.demandOwners.isEmpty
            if enabled {
                s.demandOwners.insert(owner)
            } else {
                s.demandOwners.remove(owner)
            }
            return (wasEnabled, !s.demandOwners.isEmpty)
        }
        guard transition.wasEnabled != transition.isEnabled else { return }
        setCaptureEnabled(transition.isEnabled)
    }

    func setEnabled(_ enabled: Bool) {
        setDemand(owner: .client("legacy"), enabled: enabled)
    }

    private func setCaptureEnabled(_ enabled: Bool) {
        if enabled {
            logger.notice("thumbnails enabled")
            installSpaceChangeObserver()
            startRefreshLoop()
            // Kick off an immediate capture so the client sees thumbnails
            // before the first timer tick.
            scheduleCapture(reason: "enable")
        } else {
            logger.notice("thumbnails disabled")
            uninstallSpaceChangeObserver()
            refreshTask?.cancel()
            refreshTask = nil
            // Keep the last-good snapshot. Individual consumers clear
            // themselves when they disable previews; retaining the cache
            // lets the next consumer render immediately while a fresh
            // capture runs in the background.
        }
    }

    // One-shot force-refresh of a single Space. Used by the client's
    // long-press-to-refresh affordance. The spaceId hint lets the
    // compositor prioritise that Space if we ever cap capture work per
    // tick; v0 captures all non-active Spaces on every tick anyway,
    // so the hint is recorded but not consulted by the compositor.
    func forceRefresh(spaceId: UInt64) {
        let shouldSchedule = state.withLock { s -> Bool in
            guard !s.demandOwners.isEmpty else { return false }
            s.pendingForceRefreshSpaceId = spaceId
            return true
        }
        guard shouldSchedule else { return }
        scheduleCapture(reason: "force-refresh \(spaceId)")
    }

    // MARK: - Internal

    private func installSpaceChangeObserver() {
        guard spaceChangeObserver == nil else { return }
        spaceChangeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.scheduleCapture(reason: "active-space-changed")
        }
    }

    private func uninstallSpaceChangeObserver() {
        if let observer = spaceChangeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            spaceChangeObserver = nil
        }
    }

    private func startRefreshLoop() {
        refreshTask?.cancel()
        refreshTask = Task.detached(priority: .utility) { [weak self] in
            // Don't fire an immediate tick; setCaptureEnabled already scheduled
            // one. From here, wait then capture until cancelled.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.refreshInterval * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.scheduleCapture(reason: "timer")
            }
        }
    }

    private func scheduleCapture(reason: String) {
        // In-flight guard so a timer tick that lands while a slow
        // capture is still running just skips; the next tick (or the
        // forceRefresh / Space-change observer) will pick up.
        let shouldRun = state.withLock { s -> Bool in
            guard !s.demandOwners.isEmpty, !s.capturing else { return false }
            s.capturing = true
            return true
        }
        guard shouldRun else { return }

        Task.detached(priority: .utility) { [weak self, reason] in
            guard let self else { return }
            let start = Date()
            let result = await self.captureAsync()
            let elapsed = Date().timeIntervalSince(start)
            self.logger.debug("thumbnails capture reason=\(reason, privacy: .public) spaces=\(result.thumbnails.count, privacy: .public) elapsed=\(String(format: "%.3f", elapsed), privacy: .public)s")
            self.emit(thumbnails: result.thumbnails, topWindows: result.topWindows)
            self.state.withLock { $0.capturing = false }
        }
    }

    private func emit(thumbnails: [UInt64: Data], topWindows: [UInt64: SpaceTopWindow]) {
        let continuations = state.withLock { s -> [AsyncStream<[UInt64: Data]>.Continuation] in
            s.latest = thumbnails
            s.latestTopWindows = topWindows
            return Array(s.continuations.values)
        }
        for continuation in continuations {
            continuation.yield(thumbnails)
        }
    }

    struct CaptureResult {
        var thumbnails: [UInt64: Data]
        var topWindows: [UInt64: SpaceTopWindow]
    }

    // Detached-async capture pipeline. Per-tick total time bounded by
    // the per-Space window cap. Awaits SCK directly rather than
    // bridging via a semaphore (which fights Swift 6 concurrency).
    private func captureAsync() async -> CaptureResult {
        if let captureOverride {
            return await captureOverride()
        }
        guard let sky else { return CaptureResult(thumbnails: [:], topWindows: [:]) }

        // Enumerate windows including off-screen so Spaces other than
        // the active one are visible.
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                true,
                onScreenWindowsOnly: false
            )
        } catch {
            logger.error("SCShareableContent failed: \(String(describing: error), privacy: .public)")
            return CaptureResult(thumbnails: [:], topWindows: [:])
        }

        // Filter out wallpaper, dock, menu-bar, control center, and
        // sub-50pt overlays. Keep windowLayer == 0 (regular app windows).
        let candidates = content.windows.filter { win in
            guard let app = win.owningApplication else { return false }
            if app.bundleIdentifier == "com.apple.dock" { return false }
            if app.bundleIdentifier == "com.apple.WindowManager" { return false }
            if app.bundleIdentifier == "com.apple.controlcenter" { return false }
            if win.windowLayer != 0 { return false }
            if win.frame.width < 50 || win.frame.height < 50 { return false }
            return true
        }
        if candidates.isEmpty { return CaptureResult(thumbnails: [:], topWindows: [:]) }

        // Map windowID -> spaceID via SkyLight. Per-window query is
        // O(W); for v0 W is small (single-digit to low-double-digit).
        // R28 follow-up: include the active Space too. The client's
        // active tile now reads as "selected" via a transparent
        // border-only overlay over the same thumbnail every other tile
        // has, so an empty active tile would look inconsistent. The
        // duplicate capture cost (active Space is also on the WebRTC
        // stream) is a few ms every 3s. Trivial.
        var windowsBySpace: [UInt64: [SCWindow]] = [:]
        for win in candidates {
            let wid = CGWindowID(win.windowID)
            guard let spaceId = sky.firstSpaceContaining(windowID: wid) else { continue }
            windowsBySpace[spaceId, default: []].append(win)
        }
        if windowsBySpace.isEmpty { return CaptureResult(thumbnails: [:], topWindows: [:]) }

        var thumbnailsOut: [UInt64: Data] = [:]
        var topWindowsOut: [UInt64: SpaceTopWindow] = [:]
        for (spaceId, windows) in windowsBySpace {
            // Cap per-Space windows to keep capture cost bounded. Same
            // area-sorted order is used to pick the dominant window's
            // label, so the title we surface matches the thumbnail's
            // most-prominent window.
            let ranked = windows
                .sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
            if let top = ranked.first {
                topWindowsOut[spaceId] = SpaceTopWindow(
                    title: top.title ?? "",
                    appName: top.owningApplication?.applicationName
                )
            }
            let topRanked = ranked.prefix(Self.maxWindowsPerSpace)
            var captured: [(image: CGImage, frame: CGRect)] = []
            for win in topRanked {
                if let cg = await captureWindow(win) {
                    captured.append((cg, win.frame))
                }
            }
            if captured.isEmpty { continue }
            let canvas = Self.canvasFrame(for: captured.map(\.frame), displays: content.displays)
            guard let jpeg = Self.composite(captured: captured, canvas: canvas) else { continue }
            thumbnailsOut[spaceId] = jpeg
        }
        return CaptureResult(thumbnails: thumbnailsOut, topWindows: topWindowsOut)
    }

    // Pick the display the captured windows live on so the thumbnail's
    // canvas matches the actual desktop. Falls back to the union of
    // window frames when no display contains the windows (multi-monitor
    // edge cases, or displays array was empty).
    static func canvasFrame(for windowFrames: [CGRect], displays: [SCDisplay]) -> CGRect {
        let windowUnion = windowFrames.reduce(CGRect.null) { $0.union($1) }
        let containing = displays.first { display in
            display.frame.intersection(windowUnion).width > 0
        }
        if let containing { return containing.frame }
        if !windowUnion.isNull, windowUnion.width > 0, windowUnion.height > 0 {
            return windowUnion
        }
        return displays.first?.frame ?? CGRect(x: 0, y: 0, width: 1920, height: 1200)
    }

    private func captureWindow(_ window: SCWindow) async -> CGImage? {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = max(1, Int(window.frame.width))
        config.height = max(1, Int(window.frame.height))
        config.showsCursor = false
        do {
            return try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        } catch {
            logger.debug("window capture failed wid=\(window.windowID, privacy: .public) err=\(String(describing: error), privacy: .public)")
            return nil
        }
    }

    // Pure compositor; unit-testable. Scales the supplied display canvas
    // to fit the thumbnail and draws the captured windows in their actual
    // positions on that canvas, so each tile looks like the whole desktop
    // shrunk down (matching Mission Control), not just the bounding box of
    // the windows. JPEG-encodes the result. Background is dark grey so
    // empty regions of the desktop read as wallpaper-ish.
    static func composite(captured: [(image: CGImage, frame: CGRect)], canvas: CGRect) -> Data? {
        guard !captured.isEmpty, canvas.width > 0, canvas.height > 0 else { return nil }
        let w = thumbnailWidth
        let h = thumbnailHeight
        let scale = min(CGFloat(w) / canvas.width, CGFloat(h) / canvas.height)
        let offsetX = (CGFloat(w) - canvas.width * scale) / 2
        let offsetY = (CGFloat(h) - canvas.height * scale) / 2

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(
            data: nil,
            width: w,
            height: h,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }

        ctx.interpolationQuality = .high
        ctx.setShouldAntialias(true)
        ctx.setFillColor(CGColor(red: 0.10, green: 0.10, blue: 0.12, alpha: 1.0))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))

        // Flip the context to a top-left origin space so SCKit's screen
        // coordinates and CGImage's natural row order both map directly.
        // Without this, ctx.draw renders each window image upside-down
        // (CG draws images bottom-up by default in a y-up context), which
        // shows up as the window's title bar / traffic-light buttons
        // landing at the bottom of the tile.
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)

        for (img, frame) in captured {
            let dx = (frame.minX - canvas.minX) * scale + offsetX
            let dy = (frame.minY - canvas.minY) * scale + offsetY
            let dw = frame.width * scale
            let dh = frame.height * scale
            ctx.draw(img, in: CGRect(x: dx, y: dy, width: dw, height: dh))
        }

        guard let composed = ctx.makeImage() else { return nil }
        let buffer = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            buffer,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else { return nil }
        let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: jpegQuality]
        CGImageDestinationAddImage(dest, composed, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return buffer as Data
    }
}

// MARK: - SkyLight binding

// Owns `SLSCopySpacesForWindows` and `SLSGetActiveSpace` resolution. Kept
// isolated from `SpacesProvider`'s SkyLight struct so a symbol change
// here doesn't ripple into Spaces enumeration / switching.
//
// Probes SLS- prefixed names first (yabai 2026 convention), falls back
// to the legacy CGS- aliases. dlopen + dlsym pattern matches
// SpacesProvider.swift.
struct SkyLightThumbnailBinding {
    typealias MainConnectionIDFn = @convention(c) () -> Int32
    typealias GetActiveSpaceFn = @convention(c) (Int32) -> UInt64
    typealias CopySpacesForWindowsFn = @convention(c) (Int32, Int32, CFArray) -> CFArray?

    let connectionID: Int32
    private let getActiveSpace: GetActiveSpaceFn
    private let copySpacesForWindows: CopySpacesForWindowsFn

    static let shared: SkyLightThumbnailBinding? = {
        let path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
        guard let handle = dlopen(path, RTLD_NOW) else { return nil }
        func resolve(_ slsName: String, _ cgsName: String) -> UnsafeMutableRawPointer? {
            dlsym(handle, slsName) ?? dlsym(handle, cgsName)
        }
        guard
            let p1 = resolve("SLSMainConnectionID", "CGSMainConnectionID"),
            let p2 = resolve("SLSGetActiveSpace", "CGSGetActiveSpace"),
            let p3 = resolve("SLSCopySpacesForWindows", "CGSCopySpacesForWindows")
        else { return nil }
        let main = unsafeBitCast(p1, to: MainConnectionIDFn.self)
        let active = unsafeBitCast(p2, to: GetActiveSpaceFn.self)
        let spaces = unsafeBitCast(p3, to: CopySpacesForWindowsFn.self)
        return SkyLightThumbnailBinding(
            connectionID: main(),
            getActiveSpace: active,
            copySpacesForWindows: spaces
        )
    }()

    func activeSpaceId() -> UInt64 {
        getActiveSpace(connectionID)
    }

    // Returns the first Space id that contains the given window. nil
    // when the window is in no Space (rare; usually system overlays).
    // kCGSAllSpacesMask = 0x7 (Current | Others | User).
    func firstSpaceContaining(windowID: CGWindowID) -> UInt64? {
        let arr = [NSNumber(value: UInt32(windowID))] as CFArray
        guard let raw = copySpacesForWindows(connectionID, 7, arr) else { return nil }
        guard let array = raw as? [NSNumber], let first = array.first else { return nil }
        return first.uint64Value
    }
}
