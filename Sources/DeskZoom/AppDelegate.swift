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
        openWindow(for: display)
        Task {
            await self.waitForScreen(display.displayID)
            do {
                try display.selectDeclaredMode()
            } catch {
                fail("\(error)")
            }
            await self.waitForScreenSize(display)
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
        let view = CanvasView(canvas: display.size, displayID: display.displayID)
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
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Zoom lives in the title bar because trackpad gestures only reach DeskZoom while its window
        // is focused; once the cursor is teleported onto the canvas, a pinch belongs to the app there.
        let controls = ZoomControls()
        controls.onZoom = { [weak view] factor in view?.zoomAroundCenter(by: factor) }
        controls.onFit = { [weak view] in view?.fit() }
        controls.update(with: view.viewport)
        window.addTitlebarAccessoryViewController(controls)
        self.zoomControls = controls

        view.onViewportChange = { [weak self] viewport in
            self?.zoomControls?.update(with: viewport)
            self?.scheduleCaptureUpdate()
        }
        view.onCursorPresenceChange = { [weak self] present in
            self?.cursorOnCanvas = present
            self?.updateTitle()
        }
        self.window = window
        self.canvasView = view
        updateTitle()
    }

    private func startCapture(for display: VirtualDisplay) async {
        guard let view = canvasView else { return }
        let capture = DisplayCapture(displayID: display.displayID)
        capture.onFrame = { [weak self, weak view] frame, region in
            MainActor.assumeIsolated {
                view?.show(frame: frame, region: region)
                guard let self else { return }
                self.frameCount += 1
                // Cheap liveness readout. A stalled capture is otherwise silent: the picture simply stops,
                // with no error, and it took two rounds of guessing before this made it obvious.
                if self.frameCount % 30 == 0 { self.updateTitle() }
            }
        }
        capture.onStop = { error in fail("\(error)") }
        // The first launch has no Screen Recording grant: ScreenCaptureKit reports "declined" while the
        // system prompt is still up. Keep retrying so an Allow in System Settings takes effect without a relaunch.
        while true {
            do {
                let plan = view.capturePlan
                try await capture.setRegion(sourceRect: plan.region, outputPixelSize: plan.pixelSize)
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
        self.capture = capture
        await startOverviewCapture(for: display, view: view)
        updateTitle()
    }

    /// A second, permanent stream of the whole canvas at low resolution. It never moves, so it is always
    /// there to draw under the sharp capture while that one is being re-aimed.
    private func startOverviewCapture(for display: VirtualDisplay, view: CanvasView) async {
        let overview = DisplayCapture(displayID: display.displayID)
        overview.onFrame = { [weak view] frame, region in
            MainActor.assumeIsolated { view?.showOverview(frame: frame, region: region) }
        }
        overview.onStop = { error in fail("\(error)") }
        let whole = CGRect(origin: .zero, size: display.size)
        do {
            try await overview.setRegion(sourceRect: whole, outputPixelSize: CanvasView.overviewPixelSize(for: display.size))
        } catch {
            fail("\(error)")
        }
        overviewCapture = overview
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

    private func scheduleCaptureUpdate() {
        pendingCaptureUpdate?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.applyCaptureUpdate() }
        pendingCaptureUpdate = work
        // Aiming a fresh stream is expensive, so normally wait for movement to settle. But once the view
        // has moved off what was captured, the uncovered part is showing background, so go at once.
        let uncovered = canvasView.map { !$0.isServed(by: capture?.plan) } ?? false
        DispatchQueue.main.asyncAfter(deadline: .now() + (uncovered ? 0.03 : 0.25), execute: work)
    }

    private func applyCaptureUpdate() {
        guard let capture, let view = canvasView else { return }
        if captureUpdateInFlight {
            captureUpdateQueued = true
            return
        }
        // Panning inside the padded region already on screen needs no new stream, and starting one per
        // mouse move is what made the machine crawl.
        guard !view.isServed(by: capture.plan) else { return }
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

    // MARK: Menu and title

    private func installMenu() {
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        appMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
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
        } else if capture == nil {
            state = "choose Extended Display"
        } else if accessibilityMissing {
            state = "allow Accessibility"
        } else if cursorOnCanvas {
            state = "cursor here, ⌘B returns it"
        } else {
            state = "click to move the cursor here"
        }
        window?.title = "DeskZoom \(config.width)×\(config.height) · \(frameCount) frames · \(state)"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "dev"
        window?.contentView?.toolTip = "DeskZoom build \(build)"
    }
}
