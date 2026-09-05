import AppKit
import ApplicationServices
import CoreGraphics

/// Intercepts input while the pointer is on the virtual display, and leaves every other display alone.
///
/// Two jobs, one tap. A second tap would mean every event waits on two callbacks.
///
/// 1. **Pointer travel.** Movement is multiplied so a 7680-point-wide canvas takes about as much hand
///    movement to cross as the main screen. The multiplier is speed-dependent, the way macOS pointer
///    acceleration works: a slow, deliberate move stays at 1x so small controls remain clickable, and a
///    fast flick gets the full gain. A flat multiplier was the first attempt and it made precise pointing
///    on the canvas impossible.
/// 2. **Pinch zoom.** Magnify gestures are swallowed and turned into canvas zoom, so pinching zooms the
///    view of the virtual display rather than whatever app happens to sit under the pointer. This is the
///    only way to get pinch zoom there at all: AppKit only delivers gestures to the focused window, and
///    once the pointer is teleported onto the canvas that is never DeskZoom.
///
/// This is an *active* tap, so the window server waits for this callback before delivering each event.
/// It therefore runs on its own thread: parked on the main run loop it queued behind capture work and
/// drawing, and typing across the whole machine stalled with it. Nothing in the callback may block, wait
/// on the main thread, or touch the app's state.
final class CanvasInputTap {
    /// Pointer speed, in points per event, at which the full gain is reached.
    private static let fullGainSpeed: CGFloat = 24
    /// How long the display's bounds are cached, so the callback does no lookup on most events.
    private static let boundsLifetime: TimeInterval = 1
    /// Trackpad gestures arrive as this event type. CoreGraphics has no name for it, so the raw value is
    /// the only handle. Measured 2026-09-04: a pinch produces type 29, never the 30 that AppKit reports to
    /// a focused app, and a tap asking only for bit 29 receives nothing at all. Only a tap requesting every
    /// event is given gestures, so the pinch tap takes everything and discards the rest immediately.
    private static let gestureEventType = CGEventType(rawValue: 29)!

    private let displayID: CGDirectDisplayID
    private let gain: CGFloat
    private let capturesPinch: Bool

    private var thread: Thread?
    /// Pointer movement is rewritten at the HID layer, because that is where the cursor's position is
    /// decided; a session-level rewrite changes only the coordinates an app is told about, and the cursor
    /// does not move (measured 2026-09-04: gain fell to 1.0). Pinch gestures do not exist at the HID layer
    /// at all, since the window server synthesizes them, so they need a session tap. Hence two taps, sharing
    /// one thread and one run loop.
    private var pointerTap: CFMachPort?
    private var pinchTap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var didStart = false
    private let ready = DispatchSemaphore(value: 0)

    private var pointerContext: TapContext?
    private var pinchContext: TapContext?

    private let boundsLock = NSLock()
    private var cachedBounds = CGRect.zero
    private var cachedBoundsAt = Date.distantPast

    /// Called on the main thread with a pinch magnification delta, positive to zoom in.
    var onPinch: ((CGFloat) -> Void)?

    /// Whether a pinch has ever reached this tap. Reported once per run, because "pinch does nothing"
    /// is otherwise indistinguishable from "the gesture never arrived".
    private var sawPinch = false

    init(displayID: CGDirectDisplayID, gain: CGFloat, capturesPinch: Bool) {
        self.displayID = displayID
        self.gain = gain
        self.capturesPinch = capturesPinch
    }

    deinit {
        for tap in [pointerTap, pinchTap].compactMap({ $0 }) {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        thread?.cancel()
        if let runLoop { CFRunLoopStop(runLoop) }
    }

    static var isTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Shows the system Accessibility prompt once. The grant lands asynchronously; poll `isTrusted`.
    static func requestTrust() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    /// Returns false when the tap cannot be created, which in practice means no Accessibility grant.
    /// Safe to call again after a failure.
    func start() -> Bool {
        if let thread, !thread.isFinished { return didStart }
        let thread = Thread { [weak self] in self?.run() }
        thread.name = "deskzoom.canvas-input"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
        ready.wait()
        if !didStart { self.thread = nil }
        return didStart
    }

    private func run() {
        // Each tap gets its own context so the callback knows which one fired. Without that, the pinch
        // tap's all-event stream would run through the pointer boost as well and double-apply it.
        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else { return Unmanaged.passUnretained(event) }
            let context = Unmanaged<TapContext>.fromOpaque(userInfo).takeUnretainedValue()
            return context.owner.handle(role: context.role, type: type, event: event)
        }

        if gain != 1 {
            let movement: CGEventMask = (1 << CGEventType.mouseMoved.rawValue)
                | (1 << CGEventType.leftMouseDragged.rawValue)
                | (1 << CGEventType.rightMouseDragged.rawValue)
                | (1 << CGEventType.otherMouseDragged.rawValue)
            let context = TapContext(role: .pointer, owner: self)
            pointerContext = context
            pointerTap = Self.makeTap(.cghidEventTap, mask: movement, callback: callback, context: Unmanaged.passUnretained(context).toOpaque())
        }
        if capturesPinch {
            let context = TapContext(role: .pinch, owner: self)
            pinchContext = context
            pinchTap = Self.makeTap(.cgSessionEventTap, mask: ~CGEventMask(0), callback: callback, context: Unmanaged.passUnretained(context).toOpaque())
        }

        let wanted = (gain != 1 ? 1 : 0) + (capturesPinch ? 1 : 0)
        let made = [pointerTap, pinchTap].compactMap { $0 }.count
        guard made == wanted, made > 0 else {
            for tap in [pointerTap, pinchTap].compactMap({ $0 }) { CGEvent.tapEnable(tap: tap, enable: false) }
            pointerTap = nil
            pinchTap = nil
            didStart = false
            ready.signal()
            return
        }
        self.runLoop = CFRunLoopGetCurrent()
        didStart = true
        ready.signal()

        while !Thread.current.isCancelled {
            CFRunLoopRunInMode(.defaultMode, 1, false)
        }
    }

    private static func makeTap(_ location: CGEventTapLocation, mask: CGEventMask, callback: @escaping CGEventTapCallBack, context: UnsafeMutableRawPointer) -> CFMachPort? {
        guard let tap = CGEvent.tapCreate(
            tap: location,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: context
        ) else { return nil }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return tap
    }

    private func canvasBounds() -> CGRect {
        boundsLock.lock()
        defer { boundsLock.unlock() }
        if Date().timeIntervalSince(cachedBoundsAt) > Self.boundsLifetime {
            cachedBounds = CGDisplayBounds(displayID)
            cachedBoundsAt = Date()
        }
        return cachedBounds
    }

    private func handle(role: TapContext.Role, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            for tap in [pointerTap, pinchTap].compactMap({ $0 }) { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        switch role {
        case .pinch:
            // This tap sees every event on the system. Everything that is not a gesture leaves immediately;
            // it must never become a place where other input can be delayed.
            guard type == Self.gestureEventType else { return Unmanaged.passUnretained(event) }
            return handlePinch(event)
        case .pointer:
            guard canvasBounds().contains(event.location) else { return Unmanaged.passUnretained(event) }
            return boostPointer(event)
        }
    }

    /// Turns a pinch into canvas zoom and consumes it, so the app under the pointer never sees it.
    /// A gesture whose amount cannot be read is passed on rather than silently eaten.
    private func handlePinch(_ event: CGEvent) -> Unmanaged<CGEvent>? {
        // A gesture event's own location is not the pointer's, so ask where the pointer actually is.
        let cursor = CGEvent(source: nil)?.location ?? event.location
        guard canvasBounds().contains(cursor) else { return Unmanaged.passUnretained(event) }

        let magnification = Self.magnification(of: event)
        if !sawPinch {
            sawPinch = true
            report("pinch on canvas at \(Int(cursor.x)),\(Int(cursor.y)) magnification " +
                   (magnification.map { String(format: "%.4f", $0) } ?? "UNREADABLE fields \(Self.nonzeroFields(of: event))"))
        }
        guard let magnification, magnification != 0 else { return Unmanaged.passUnretained(event) }
        DispatchQueue.main.async { [weak self] in self?.onPinch?(magnification) }
        return nil
    }

    /// The pinch amount. AppKit exposes it on magnify events, and a gesture event converts to one; if that
    /// ever stops working the caller reports the raw fields instead of guessing.
    private static func magnification(of event: CGEvent) -> CGFloat? {
        guard let ns = NSEvent(cgEvent: event), ns.type == .magnify else { return nil }
        return ns.magnification
    }

    /// Diagnostic only: which numeric fields carry something, so an unreadable gesture reports itself.
    private static func nonzeroFields(of event: CGEvent) -> String {
        (100...140).compactMap { raw -> String? in
            guard let field = CGEventField(rawValue: UInt32(raw)) else { return nil }
            let value = event.getDoubleValueField(field)
            return value == 0 ? nil : "f\(raw)=\(String(format: "%.4f", value))"
        }.joined(separator: " ")
    }

    private func report(_ message: String) {
        FileHandle.standardError.write("DeskZoom: \(message)\n".data(using: .utf8)!)
    }

    private func boostPointer(_ event: CGEvent) -> Unmanaged<CGEvent>? {
        let canvas = canvasBounds()
        let location = event.location
        let dx = CGFloat(event.getDoubleValueField(.mouseEventDeltaX))
        let dy = CGFloat(event.getDoubleValueField(.mouseEventDeltaY))
        let extra = accelerationFactor(forSpeed: hypot(dx, dy)) - 1
        guard extra > 0 else { return Unmanaged.passUnretained(event) }
        let boosted = CGPoint(x: location.x + dx * extra, y: location.y + dy * extra)

        // Leaving the canvas keeps the unboosted step so the edge crossing back to the main display still works.
        guard canvas.contains(boosted) else { return Unmanaged.passUnretained(event) }
        // Only the location is rewritten. Rewriting the delta fields as well made the cursor jump erratically
        // (measured 2026-09-04 with an event tap harness); the window server re-applies the deltas.
        event.location = boosted
        return Unmanaged.passUnretained(event)
    }

    /// 1 at rest, rising quadratically to `gain` at `fullGainSpeed`. The curve is squared rather than
    /// linear so the low-speed end stays close to 1x, which is where pointing accuracy is spent.
    private func accelerationFactor(forSpeed speed: CGFloat) -> CGFloat {
        let t = min(1, speed / Self.fullGainSpeed)
        return 1 + (gain - 1) * t * t
    }
}

/// Which tap a callback came from. The two taps live at different levels and must not share behaviour.
private final class TapContext {
    enum Role { case pointer, pinch }
    let role: Role
    unowned let owner: CanvasInputTap
    init(role: Role, owner: CanvasInputTap) {
        self.role = role
        self.owner = owner
    }
}
