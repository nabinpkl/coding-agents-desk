import AppKit
import ScreenCaptureKit

struct DeskZoomConfig {
    var width = 7680
    var height = 4800
    /// Pointer travel multiplier while the cursor is on the virtual display. 1 disables the boost.
    var pointerGain: Double = 3
    /// Whether pinch gestures made on the virtual display are taken over to zoom the canvas.
    var pinchZoom = true

    /// Parses `--width N --height N --pointer-gain X --pinch-zoom 0|1`.
    /// Anything else is a hard error: no silent defaults on typos.
    static func parse(_ arguments: [String]) -> DeskZoomConfig {
        var config = DeskZoomConfig()
        var rest = arguments.dropFirst()
        while let flag = rest.popFirst() {
            guard let value = rest.popFirst(), let number = Double(value) else {
                fail("usage: DeskZoom [--width N] [--height N] [--pointer-gain X] [--pinch-zoom 0|1]")
            }
            switch flag {
            case "--width": config.width = Int(number)
            case "--height": config.height = Int(number)
            case "--pointer-gain": config.pointerGain = number
            case "--pinch-zoom": config.pinchZoom = number != 0
            default: fail("unknown flag \(flag)")
            }
        }
        return config
    }
}

/// Report an unrecoverable error to the user and exit. There is no degraded mode worth running.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write("DeskZoom: \(message)\n".data(using: .utf8)!)
    let showAlert = {
        guard NSApp != nil else { return }
        let alert = NSAlert()
        alert.messageText = "DeskZoom cannot continue"
        alert.informativeText = message
        alert.runModal()
    }
    if Thread.isMainThread {
        showAlert()
    } else {
        DispatchQueue.main.sync(execute: showAlert)
    }
    exit(1)
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let config: DeskZoomConfig
    private var virtualDisplay: VirtualDisplay?
    private var capture: DisplayCapture?
    private var overviewCapture: DisplayCapture?
    private var window: NSWindow?
    private var canvasView: CanvasView?
    private var pendingCaptureUpdate: DispatchWorkItem?
    private var captureUpdateInFlight = false
    private var captureUpdateQueued = false
    private var lastRegionChange = Date.distantPast
    private let viewportStore = ViewportStore()
    private var controlSocket: ControlSocket?
    /// Where a script reaches the fake cursor. One literal in one place; it moves to config if a second
    /// reader ever appears.
    static let controlSocketPath = "/tmp/deskzoom.sock"
    private static let canvasDefaultsKey = "canvasWidth"
    /// How long the slider must sit still before the display is actually reconfigured. Short enough to feel
    /// immediate, long enough that dragging across the ladder does not reconfigure at every rung it passes.
    private static let canvasSettleDelay: TimeInterval = 0.2
    private var pendingCanvas: DispatchWorkItem?
    private var canvasChangeInFlight = false
    private var queuedCanvas: VirtualDisplay.Canvas?
    private var pendingViewportSave: DispatchWorkItem?
    private var cursorOnCanvas = false
    private var frameCount = 0
    private var screenRecordingDenied = false
    private var zoomControls: ZoomControls?
    private var inputTap: CanvasInputTap?
    private var accessibilityMissing = false

    init(config: DeskZoomConfig) {
        self.config = config
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()
        let display: VirtualDisplay
        do {
            display = try VirtualDisplay(width: config.width, height: config.height, name: "DeskZoom \(config.width)x\(config.height)")
        } catch {
            fail("\(error)")
        }
        virtualDisplay = display
        Task {
            await self.waitForScreen(display.displayID)
            do {
                // Until the mode is chosen the display's size is only what was asked for; a HiDPI display
                // reports half of it in points, and the canvas is measured in points, so the window cannot
                // be built before this.
                try display.selectDeclaredMode()
            } catch {
                fail("\(error)")
            }
            await self.waitForScreenSize(display)
            if let remembered = self.rememberedCanvas(in: display.ladder) {
                try? display.select(canvas: remembered)
                await self.waitForScreenSize(display)
            }
            self.openWindow(for: display)
            await self.startCapture(for: display)
            // Leave the canvas belonging to the Finder rather than to DeskZoom: DeskZoom is a window on the
            // built-in screen, and a display whose menu bar says DeskZoom is a display nothing will open on.
            CanvasFocus.activateFinder()
            await self.startInputTap(for: display)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: Setup

    /// macOS 26 treats the new display like an AirPlay receiver and asks the user what to show on it.
    /// Nothing is online until they pick "Extended Display" and click Start, so wait as long as it takes.
    private func waitForScreen(_ displayID: CGDirectDisplayID) async {
        while !NSScreen.screens.contains(where: { $0.displayID == displayID }) {
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    /// After a mode switch AppKit takes a moment to report the new frame; capture must not start before that.
    private func waitForScreenSize(_ display: VirtualDisplay) async {
        while !(NSScreen.screens.contains { $0.displayID == display.displayID && $0.frame.size == display.size }) {
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    private func openWindow(for display: VirtualDisplay) {
        let view = CanvasView(canvas: display.size, displayID: display.displayID, restoring: viewportStore.load(canvas: display.size))
        let mainFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let aspect = display.size.width / display.size.height
        var size = CGSize(width: mainFrame.width * 0.9, height: mainFrame.width * 0.9 / aspect)
        if size.height > mainFrame.height * 0.9 {
            size = CGSize(width: mainFrame.height * 0.9 * aspect, height: mainFrame.height * 0.9)
        }
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = view
        window.contentAspectRatio = display.size
        window.contentMinSize = CGSize(width: 480, height: 480 / aspect)
        // The window's own place is worth keeping across rebuilds for the same reason the zoom is.
        window.setFrameAutosaveName("viewer")
        if !window.setFrameUsingName("viewer") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Zoom lives in the title bar because trackpad gestures only reach DeskZoom while its window
        // is focused; once the cursor is teleported onto the canvas, a pinch belongs to the app there.
        let controls = ZoomControls()
        controls.onZoom = { [weak view] factor in view?.zoomAroundCenter(by: factor) }
        controls.onFit = { [weak view] in view?.fit() }
        controls.onActualSize = { [weak view] in view?.actualSize() }
        controls.setLadder(display.ladder, current: display.size.width)
        controls.onCanvasChange = { [weak self] canvas in self?.selectCanvas(canvas) }
        controls.update(with: view.viewport)
        window.addTitlebarAccessoryViewController(controls)
        self.zoomControls = controls

        view.maxPixelsPerPoint = display.pixelsPerPoint
        view.onViewportChange = { [weak self] viewport in
            self?.zoomControls?.update(with: viewport)
            self?.scheduleCaptureUpdate()
            self?.scheduleViewportSave(viewport)
        }
        view.onCursorPresenceChange = { [weak self] present in
            self?.cursorOnCanvas = present
            self?.updateTitle()
        }
        self.window = window
        self.canvasView = view
        startControlSocket()
        updateTitle()
    }

    /// Starts the whole-canvas capture, which always runs, and the sharp one only if the overview is not
    /// already detailed enough. Permission is waited on here because this is the first stream to start.
    private func startCapture(for display: VirtualDisplay) async {
        let overview = DisplayCapture(displayID: display.displayID)
        overview.onFrame = { [weak self] frame, region in
            MainActor.assumeIsolated {
                self?.canvasView?.showOverview(frame: frame, region: region)
                self?.countFrame()
            }
        }
        overview.onStop = { error in fail("\(error)") }

        let whole = CGRect(origin: .zero, size: display.size)
        let pixels = CanvasView.overviewPixelSize(for: display.size, pixelsPerPoint: display.pixelsPerPoint)
        // The first launch has no Screen Recording grant: ScreenCaptureKit reports "declined" while the
        // system prompt is still up. Keep retrying so an Allow in System Settings takes effect without a relaunch.
        while true {
            do {
                try await overview.setRegion(sourceRect: whole, outputPixelSize: pixels)
                break
            } catch let error as SCStreamError where error.code == .userDeclined {
                screenRecordingDenied = true
                updateTitle()
                try? await Task.sleep(for: .seconds(3))
            } catch {
                fail("\(error)")
            }
        }
        screenRecordingDenied = false
        overviewCapture = overview
        updateTitle()
        scheduleCaptureUpdate(after: 0)
    }

    /// The sharp capture of whatever region is being looked at. Created on demand, and torn down again
    /// whenever the overview alone can serve the view.
    private func startDetailCapture() -> DisplayCapture? {
        guard virtualDisplay != nil else { return nil }
        let detail = DisplayCapture(displayID: virtualDisplay!.displayID)
        detail.onFrame = { [weak self] frame, region in
            MainActor.assumeIsolated {
                self?.canvasView?.show(frame: frame, region: region)
                self?.countFrame()
            }
        }
        detail.onStop = { error in fail("\(error)") }
        capture = detail
        return detail
    }

    /// Cheap liveness readout. A stalled capture is otherwise silent: the picture simply stops, with no
    /// error, and it took two rounds of guessing before this made it obvious.
    private func countFrame() {
        frameCount += 1
        if frameCount % 30 == 0 { updateTitle() }
    }

    /// The event tap needs the Accessibility grant. Prompt once, then keep trying until it lands.
    private func startInputTap(for display: VirtualDisplay) async {
        guard config.pointerGain != 1 || config.pinchZoom else { return }
        let tap = CanvasInputTap(displayID: display.displayID, gain: config.pointerGain, capturesPinch: config.pinchZoom)
        tap.onPinch = { [weak self] magnification in
            self?.canvasView?.zoomAtCursor(by: 1 + magnification)
        }
        if !CanvasInputTap.isTrusted { CanvasInputTap.requestTrust() }
        while !tap.start() {
            accessibilityMissing = true
            updateTitle()
            try? await Task.sleep(for: .seconds(3))
        }
        accessibilityMissing = false
        inputTap = tap
        updateTitle()
    }

    // MARK: Capture region follows the viewport, coalesced so pinch gestures do not flood the stream

    /// Longest a viewport change waits before the sharp capture is re-aimed at it.
    private static let captureSettleDelay: TimeInterval = 0.15
    /// Shortest gap between two re-aims. Every re-aim swaps the sharp picture for the blurred overview for
    /// as long as the new stream takes to deliver, so re-aiming on every pointer move reads as flicker.
    /// The overview is what makes waiting acceptable: nothing goes black in the meantime.
    private static let minimumRegionInterval: TimeInterval = 0.35

    private func scheduleCaptureUpdate(after delay: TimeInterval = captureSettleDelay) {
        pendingCaptureUpdate?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.applyCaptureUpdate() }
        pendingCaptureUpdate = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func applyCaptureUpdate() {
        guard let view = canvasView else { return }
        // When the overview already carries the detail the window can show, a second stream would only add
        // something to swap to and from while panning.
        guard view.needsDetailCapture else {
            if let running = capture {
                capture = nil
                Task { await running.stop() }
                view.clearDetail()
            }
            return
        }
        guard let capture = capture ?? startDetailCapture() else { return }
        if captureUpdateInFlight {
            captureUpdateQueued = true
            return
        }
        // Panning inside the padded region already on screen needs no new stream, and starting one per
        // mouse move is what made the machine crawl.
        guard !view.isServed(by: capture.plan) else { return }
        let sinceLastChange = Date().timeIntervalSince(lastRegionChange)
        guard sinceLastChange >= Self.minimumRegionInterval else {
            scheduleCaptureUpdate(after: Self.minimumRegionInterval - sinceLastChange)
            return
        }
        lastRegionChange = Date()
        captureUpdateInFlight = true
        let plan = view.capturePlan
        Task {
            do {
                try await capture.setRegion(sourceRect: plan.region, outputPixelSize: plan.pixelSize)
            } catch {
                fail("\(error)")
            }
            self.captureUpdateInFlight = false
            if self.captureUpdateQueued {
                self.captureUpdateQueued = false
                self.applyCaptureUpdate()
            }
        }
    }

    private func rememberedCanvas(in ladder: [VirtualDisplay.Canvas]) -> VirtualDisplay.Canvas? {
        let width = UserDefaults.standard.double(forKey: Self.canvasDefaultsKey)
        guard width > 0 else { return nil }
        return ladder.first { $0.size.width == CGFloat(width) }
    }

    /// The slider reports every rung it passes over, and reconfiguring a display takes a second or so, so
    /// the last one wins rather than every one being applied in turn.
    private func selectCanvas(_ canvas: VirtualDisplay.Canvas) {
        pendingCanvas?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.applyCanvas(canvas) }
        pendingCanvas = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.canvasSettleDelay, execute: work)
    }

    /// Moves the display to another rung of the ladder while running: the canvas changes size in points,
    /// so the view starts again on the new canvas and both captures are re-aimed at it.
    private func applyCanvas(_ canvas: VirtualDisplay.Canvas) {
        guard let display = virtualDisplay, let view = canvasView, canvas.size != view.viewport.canvas else { return }
        guard !canvasChangeInFlight else {
            queuedCanvas = canvas
            return
        }
        canvasChangeInFlight = true
        Task {
            do {
                try display.select(canvas: canvas)
            } catch {
                fail("\(error)")
            }
            await self.waitForScreenSize(display)
            UserDefaults.standard.set(Double(canvas.size.width), forKey: Self.canvasDefaultsKey)
            view.adopt(canvas: display.size, pixelsPerPoint: display.pixelsPerPoint)
            self.window?.contentAspectRatio = display.size
            await self.capture?.stop()
            await self.overviewCapture?.stop()
            self.capture = nil
            self.overviewCapture = nil
            await self.startCapture(for: display)
            self.zoomControls?.update(with: view.viewport)
            self.updateTitle()
            self.canvasChangeInFlight = false
            if let queued = self.queuedCanvas {
                self.queuedCanvas = nil
                self.applyCanvas(queued)
            }
        }
    }

    private func startControlSocket() {
        guard controlSocket == nil else { return }
        let socket = ControlSocket(path: Self.controlSocketPath) { [weak self] line in
            self?.runControl(line) ?? "error: not ready"
        }
        do {
            try socket.start()
        } catch {
            fail("\(error)")
        }
        controlSocket = socket
    }

    /// Answers one control line. Kept to plain text both ways so a shell can drive it with nc. Most
    /// replies are one line; `windows` is one line per window.
    private func runControl(_ line: String) -> String {
        guard let view = canvasView, let display = virtualDisplay else { return "error: not ready" }
        guard let command = ControlCommand.parse(line) else { return "error: \(ControlCommand.usage)" }
        let canvas = view.viewport.canvas
        let bounds = CGDisplayBounds(display.displayID)
        func onScreen(_ point: CGPoint) -> CGPoint { CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y) }
        func describeCursor(_ cursor: CGPoint) -> String { "cursor \(Int(cursor.x)),\(Int(cursor.y))" }

        switch command {
        case let .move(point):
            view.setFakeCursor(point)
            return "ok \(describeCursor(view.fakeCursor!))"
        case let .moveFraction(fraction):
            view.setFakeCursor(CGPoint(x: fraction.x * canvas.width, y: fraction.y * canvas.height))
            return "ok \(describeCursor(view.fakeCursor!))"
        case .hide:
            view.setFakeCursor(nil)
            return "ok hidden"
        case .status:
            let cursor = view.fakeCursor.map(describeCursor) ?? "cursor none"
            return "ok canvas \(Int(canvas.width))x\(Int(canvas.height)) \(cursor) zoom \(Int(view.viewport.magnification * 100))%"
        case .windows:
            let windows = CanvasFocus.windows(onDisplayWithBounds: bounds)
            guard !windows.isEmpty else { return "ok no windows on the canvas" }
            return windows.enumerated().map { index, window in
                let f = window.frame
                let title = window.title.isEmpty ? "" : " \"\(window.title)\""
                return "\(index) \(window.owner)\(title) at \(Int(f.minX)),\(Int(f.minY)) \(Int(f.width))x\(Int(f.height))"
            }.joined(separator: "\n")
        case let .moveWindow(index):
            let windows = CanvasFocus.windows(onDisplayWithBounds: bounds)
            guard windows.indices.contains(index) else { return "error: no window \(index); run windows" }
            let window = windows[index]
            view.setFakeCursor(CGPoint(x: window.frame.midX, y: window.frame.midY))
            return "ok \(describeCursor(view.fakeCursor!)) in \(window.owner)"
        case .describe, .press, .scroll, .scrollBy:
            break
        }

        guard let cursor = view.fakeCursor else { return "error: cursor hidden; move it first" }
        let point = onScreen(cursor)
        switch command {
        case .describe:
            guard let element = CanvasFocus.element(at: point) else { return "ok nothing at \(describeCursor(cursor))" }
            return "ok \(CanvasFocus.describe(element))"
        case .press:
            guard let element = CanvasFocus.element(at: point) else { return "error: nothing at \(describeCursor(cursor))" }
            return CanvasFocus.press(element)
                ? "ok pressed \(CanvasFocus.describe(element))"
                : "error: no press action on \(CanvasFocus.describe(element))"
        case let .scroll(fraction):
            return scroll(at: point) { _ in fraction }
        case let .scrollBy(delta):
            return scroll(at: point) { current in current + delta }
        default:
            return "ok"
        }
    }

    /// Scrolls the area under a point to whatever `target` makes of its current position, and reports
    /// where it ended up. The fake cursor is the anchor: what scrolls is whatever it is over, and it
    /// stays put on screen while the content moves under it, like a real pointer would.
    private func scroll(at point: CGPoint, to target: (CGFloat) -> CGFloat) -> String {
        guard let area = CanvasFocus.scrollArea(at: point) else { return "error: nothing scrollable here" }
        guard let current = CanvasFocus.verticalScroll(of: area) else { return "error: nothing to scroll here" }
        let wanted = min(max(0, target(current)), 1)
        guard CanvasFocus.setVerticalScroll(of: area, to: wanted) else { return "error: scroll refused" }
        let landed = CanvasFocus.verticalScroll(of: area) ?? wanted
        return String(format: "ok scrolled %.2f -> %.2f", current, landed)
    }

    /// Written after movement settles rather than on every pan, since this runs on every pointer move.
    private func scheduleViewportSave(_ viewport: Viewport) {
        pendingViewportSave?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.viewportStore.save(viewport) }
        pendingViewportSave = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }

    // MARK: Menu and title

    private func installMenu() {
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        appMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        appMenu.addItem(withTitle: "Actual Size", action: #selector(actualSize), keyEquivalent: "1")
        appMenu.addItem(withTitle: "Fit Whole Display", action: #selector(fitWholeDisplay), keyEquivalent: "0")
        appMenu.addItem(withTitle: "Bring Cursor Back", action: #selector(bringCursorBack), keyEquivalent: "b")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit DeskZoom", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        let mainMenu = NSMenu()
        mainMenu.addItem(appItem)
        NSApp.mainMenu = mainMenu
    }

    @objc private func zoomIn() {
        canvasView?.zoomAroundCenter(by: 1.25)
    }

    @objc private func zoomOut() {
        canvasView?.zoomAroundCenter(by: 1 / 1.25)
    }

    @objc private func actualSize() {
        canvasView?.actualSize()
    }

    @objc private func fitWholeDisplay() {
        canvasView?.fit()
    }

    @objc private func bringCursorBack() {
        let main = CGMainDisplayID()
        let bounds = CGDisplayBounds(main)
        CGDisplayMoveCursorToPoint(main, CGPoint(x: bounds.width / 2, y: bounds.height / 2))
    }

    /// Kept short: a long title squeezes the title bar zoom controls out of the window.
    private func updateTitle() {
        let state: String
        if screenRecordingDenied {
            state = "allow Screen Recording"
        } else if overviewCapture == nil {
            state = "choose Extended Display"
        } else if accessibilityMissing {
            state = "allow Accessibility"
        } else if cursorOnCanvas {
            state = "cursor here, ⌘B returns it"
        } else {
            state = "click to move the cursor here"
        }
        let canvas = canvasView.map { "\(Int($0.viewport.canvas.width))×\(Int($0.viewport.canvas.height))" }
            ?? "\(config.width)×\(config.height)"
        window?.title = "DeskZoom \(canvas) · \(frameCount) frames · \(state)"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
        window?.contentView?.toolTip = "DeskZoom build \(build)"
    }
}
