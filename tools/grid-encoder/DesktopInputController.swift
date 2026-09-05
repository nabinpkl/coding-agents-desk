import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import QuartzCore

/// Native capability boundary for the TypeScript-owned desktop control surface.
///
/// The browser owns gestures, keyboard presentation, modifier policy, text encoding, ordering,
/// receipts, timeouts, and diagnostics. This helper owns only AX inspection and CGEvent posting.
final class DesktopInputController: @unchecked Sendable {
    typealias EventPoster = (CGEvent) -> Void
    typealias TrustProvider = () -> Bool
    typealias CursorKindProvider = () -> String
    typealias FocusSampler = () -> DesktopFocusSample

    private let bounds: CGRect
    private let emit: (Data) -> Void
    private let eventPoster: EventPoster
    private let trustProvider: TrustProvider
    private let cursorKindProvider: CursorKindProvider
    private let focusSampler: FocusSampler
    private let source: CGEventSource?
    /// The button currently held by a remote press, if any. A drag is a press, a run of moves, and
    /// a release; while it is held, movement has to be reported as a drag rather than a plain move
    /// or nothing tracks it.
    private var heldButton: CGMouseButton?
    private var heldClickState: Int64 = 1
    private let cursorActivityLock = NSLock()
    private let focusLock = NSLock()
    private var cursorPosition: CGPoint?
    private var lastCursorMoveTime: CFTimeInterval = 0
    private var lastLeftClickTime: CFTimeInterval = 0
    private var lastLeftClickLocation: CGPoint = .zero
    private var lastLeftClickState: Int64 = 0
    private var scrollRemainderX: CGFloat = 0
    private var scrollRemainderY: CGFloat = 0
    private var scrollActive = false
    private var focusGeneration: UInt64 = 0
    private var initialFocusDelayMs = 80
    private var settleFocusDelayMs = 160
    private var loggedUntrusted = false

    private static let cursorResyncIdleInterval: CFTimeInterval = 0.2
    private static let doubleClickInterval: CFTimeInterval = 0.5
    private static let doubleClickRadius: CGFloat = 5
    private static let maximumDelta: CGFloat = 10_000
    private static let maximumKeyBatch = 256
    static let maximumCommandBytes = 16 * 1_024

    init(
        bounds: CGRect,
        emit: @escaping (Data) -> Void,
        eventPoster: @escaping EventPoster = { $0.post(tap: .cghidEventTap) },
        trustProvider: @escaping TrustProvider = { AXIsProcessTrusted() },
        cursorKindProvider: @escaping CursorKindProvider = { CursorClassifier.currentKind() },
        focusSampler: @escaping FocusSampler = { DesktopFocusResolver.current() }
    ) {
        self.bounds = bounds
        self.emit = emit
        self.eventPoster = eventPoster
        self.trustProvider = trustProvider
        self.cursorKindProvider = cursorKindProvider
        self.focusSampler = focusSampler
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0
        self.source = source
    }

    var isTrusted: Bool { trustProvider() }

    func isCursorInputActive() -> Bool {
        cursorActivityLock.lock()
        let lastMove = lastCursorMoveTime
        cursorActivityLock.unlock()
        return lastMove > 0 && CACurrentMediaTime() - lastMove <= Self.cursorResyncIdleInterval
    }

    /// Returns true for every JSON control line, including malformed input, so it can never be
    /// mistaken for a capture keyframe command by the outer stdin parser.
    @discardableResult
    func handle(_ line: String) -> Bool {
        guard line.first == "{" else { return false }
        guard let data = line.data(using: .utf8) else {
            reject(reason: "malformed")
            return true
        }
        guard data.count <= Self.maximumCommandBytes else {
            reject(reason: "oversized")
            return true
        }
        guard let command = try? JSONDecoder().decode(DesktopControlCommand.self, from: data) else {
            reject(reason: "malformed")
            return true
        }
        handle(command)
        return true
    }

    private func handle(_ command: DesktopControlCommand) {
        switch command.type {
        case "configure":
            guard let initial = command.initialFocusDelayMs,
                  let settle = command.settleFocusDelayMs,
                  (0...1_000).contains(initial),
                  (0...1_000).contains(settle) else {
                reject(reason: "malformed")
                return
            }
            focusLock.lock()
            initialFocusDelayMs = initial
            settleFocusDelayMs = settle
            focusLock.unlock()
        case "pointer-move":
            guard let revision = command.revision, revision > 0, revision <= UInt32.max,
                  let dx = bounded(command.dx), let dy = bounded(command.dy) else {
                reject(reason: "malformed")
                return
            }
            withTrust { move(revision: revision, dx: dx, dy: dy) }
        case "pointer-warp":
            guard let revision = command.revision, revision > 0, revision <= UInt32.max,
                  let x = command.x, x.isFinite, x >= 0,
                  let y = command.y, y.isFinite, y >= 0 else {
                reject(reason: "malformed")
                return
            }
            withTrust { warp(revision: revision, x: CGFloat(x), y: CGFloat(y)) }
        case "click":
            guard command.button == "left" || command.button == "right" else {
                reject(reason: "malformed")
                return
            }
            if let requestID = command.focusRequestId, !Self.isFocusRequestID(requestID) {
                reject(reason: "malformed")
                return
            }
            withTrust {
                click(command.button == "left" ? .left : .right)
                if command.button == "left", let requestID = command.focusRequestId {
                    scheduleFocusProbe(requestID: requestID)
                }
            }
        case "mouse-down", "mouse-up":
            guard command.button == "left" || command.button == "right" else {
                reject(reason: "malformed")
                return
            }
            let button: CGMouseButton = command.button == "left" ? .left : .right
            withTrust {
                if command.type == "mouse-down" { press(button) } else { release(button) }
            }
        case "scroll":
            guard let dx = bounded(command.dx), let dy = bounded(command.dy),
                  let phase = command.phase.flatMap(ScrollPhase.init(rawValue:)) else {
                reject(reason: "malformed")
                return
            }
            withTrust { scroll(dx: dx, dy: dy, phase: phase) }
        case "key-batch":
            guard let sequence = command.sequence, sequence > 0,
                  let keys = command.keys, !keys.isEmpty else {
                reject(sequence: command.sequence, reason: "malformed")
                return
            }
            guard keys.count <= Self.maximumKeyBatch else {
                reject(sequence: sequence, reason: "oversized")
                return
            }
            withTrust(sequence: sequence) {
                let resolved = keys.map { key -> (CGKeyCode, CGEventFlags)? in
                    guard let virtualKey = KeyCodeMap.lookup(key.code),
                          key.modifiers.allSatisfy(Self.validModifier) else { return nil }
                    return (virtualKey, eventFlags(key.modifiers))
                }
                guard resolved.allSatisfy({ $0 != nil }) else {
                    reject(sequence: sequence, reason: "unknown-key")
                    return
                }
                for (virtualKey, flags) in resolved.compactMap({ $0 }) {
                    guard postKey(virtualKey: virtualKey, keyDown: true, flags: flags),
                          postKey(virtualKey: virtualKey, keyDown: false, flags: flags) else {
                        reject(sequence: sequence, reason: "helper-unavailable")
                        return
                    }
                }
                emitJSON(["type": "input-applied", "sequence": sequence])
            }
        case "focus-query":
            guard let requestID = command.focusRequestId, Self.isFocusRequestID(requestID) else {
                reject(reason: "malformed")
                return
            }
            withTrust { scheduleFocusProbe(requestID: requestID) }
        case "release-control":
            reset()
            cancelFocusProbe()
        default:
            reject(sequence: command.sequence, reason: "malformed")
        }
    }

    func rejectMalformed() {
        reject(reason: "malformed")
    }

    func rejectOversized() {
        reject(reason: "oversized")
    }

    private static func validModifier(_ value: String) -> Bool {
        value == "cmd" || value == "ctrl" || value == "option" || value == "shift"
    }

    private static func isFocusRequestID(_ value: String) -> Bool {
        UUID(uuidString: value) != nil
    }

    private func withTrust(sequence: UInt32? = nil, _ work: () -> Void) {
        guard isTrusted else {
            if !loggedUntrusted {
                FileHandle.standardError.write(Data(
                    "grid-encoder: Accessibility not granted; rejecting desktop input\n".utf8
                ))
                loggedUntrusted = true
            }
            reject(sequence: sequence, reason: "accessibility-denied")
            return
        }
        loggedUntrusted = false
        work()
    }

    private func bounded(_ value: Double?) -> CGFloat? {
        guard let value, value.isFinite, abs(value) <= Self.maximumDelta else { return nil }
        return CGFloat(value)
    }

    private func cursorBase() -> CGPoint {
        if let cursorPosition, isCursorInputActive() { return cursorPosition }
        return CGEvent(source: nil)?.location ?? bounds.origin
    }

    /// Absolute pointing: place the cursor at a point given in the captured display's own
    /// coordinates. `move` walks from wherever the cursor already is; this ignores that and honours
    /// the position the viewer is pointing at, which is what a mouse (unlike a finger) supplies.
    private func warp(revision: UInt64, x: CGFloat, y: CGFloat) {
        place(revision: revision, at: clamp(CGPoint(x: bounds.minX + x, y: bounds.minY + y)))
    }

    private func move(revision: UInt64, dx: CGFloat, dy: CGFloat) {
        let base = cursorBase()
        place(revision: revision, at: clamp(CGPoint(x: base.x + dx, y: base.y + dy)))
    }

    private func place(revision: UInt64, at next: CGPoint) {
        cursorPosition = next
        cursorActivityLock.lock()
        lastCursorMoveTime = CACurrentMediaTime()
        cursorActivityLock.unlock()
        // A held button turns movement into a drag. AppKit tracks a drag from these events alone;
        // sending .mouseMoved while the button is down looks to the app like the pointer teleported
        // with nothing pressed, and selections and window drags simply do not happen.
        let held = heldButton
        let moveType: CGEventType = held == .left ? .leftMouseDragged
            : held == .right ? .rightMouseDragged : .mouseMoved
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: moveType,
            mouseCursorPosition: next,
            mouseButton: held ?? .left
        ) else {
            reject(reason: "helper-unavailable")
            return
        }
        if held != nil { event.setIntegerValueField(.mouseEventClickState, value: heldClickState) }
        event.flags = []
        eventPoster(event)
        emitJSON([
            "type": "cursor-applied",
            "revision": revision,
            "x": next.x - bounds.minX,
            "y": next.y - bounds.minY,
        ])
    }

    private func clamp(_ point: CGPoint) -> CGPoint {
        CGPoint(
            x: min(max(bounds.minX, point.x), bounds.maxX - 1),
            y: min(max(bounds.minY, point.y), bounds.maxY - 1)
        )
    }

    private func click(_ button: CGMouseButton) {
        let location = cursorBase()
        if button == .left {
            let state = nextLeftClickState(at: location)
            postClick(.leftMouseDown, at: location, button: .left, clickState: state)
            postClick(.leftMouseUp, at: location, button: .left, clickState: state)
        } else {
            postClick(.rightMouseDown, at: location, button: .right, clickState: 1)
            postClick(.rightMouseUp, at: location, button: .right, clickState: 1)
        }
    }

    /// Hold a button down at the cursor, and let go of it. Split from `click` so a drag can exist:
    /// press, move, release. `click` stays the single-shot a tap wants.
    private func press(_ button: CGMouseButton) {
        guard heldButton == nil else { return }
        let location = cursorBase()
        let state = button == .left ? nextLeftClickState(at: location) : 1
        heldButton = button
        heldClickState = state
        postClick(button == .left ? .leftMouseDown : .rightMouseDown,
                  at: location, button: button, clickState: state)
    }

    private func release(_ button: CGMouseButton) {
        guard heldButton == button else { return }
        let location = cursorBase()
        let state = heldClickState
        heldButton = nil
        postClick(button == .left ? .leftMouseUp : .rightMouseUp,
                  at: location, button: button, clickState: state)
    }

    /// Let go of anything still held. A viewer that vanishes mid-drag must not leave the Mac with a
    /// button stuck down, which is indistinguishable from a wedged mouse and ruins the desktop.
    func releaseHeldButton() {
        if let held = heldButton { release(held) }
    }

    private func postClick(
        _ type: CGEventType,
        at point: CGPoint,
        button: CGMouseButton,
        clickState: Int64
    ) {
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: button
        ) else {
            reject(reason: "helper-unavailable")
            return
        }
        event.flags = []
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        eventPoster(event)
    }

    private func nextLeftClickState(at location: CGPoint) -> Int64 {
        let now = CACurrentMediaTime()
        let distance = hypot(
            location.x - lastLeftClickLocation.x,
            location.y - lastLeftClickLocation.y
        )
        let state = now - lastLeftClickTime <= Self.doubleClickInterval
            && distance <= Self.doubleClickRadius
            ? lastLeftClickState + 1
            : 1
        lastLeftClickTime = now
        lastLeftClickLocation = location
        lastLeftClickState = state
        return state
    }

    private enum ScrollPhase: String {
        case began, changed, ended, momentumBegan, momentumChanged, momentumEnded
    }

    private func scroll(dx: CGFloat, dy: CGFloat, phase: ScrollPhase) {
        if phase == .began || phase == .ended || phase == .momentumEnded {
            scrollRemainderX = 0
            scrollRemainderY = 0
        }
        scrollActive = phase == .began || phase == .changed
        scrollRemainderX += dx
        scrollRemainderY += dy
        let dxInt = Int32(scrollRemainderX.rounded(.towardZero))
        let dyInt = Int32(scrollRemainderY.rounded(.towardZero))
        scrollRemainderX -= CGFloat(dxInt)
        scrollRemainderY -= CGFloat(dyInt)
        let isDelimiter = phase != .changed && phase != .momentumChanged
        if dxInt == 0 && dyInt == 0 && !isDelimiter { return }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: dyInt,
            wheel2: dxInt,
            wheel3: 0
        ) else {
            reject(reason: "helper-unavailable")
            return
        }
        event.flags = []
        let values = phaseValues(phase)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: values.scroll)
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: values.momentum)
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        eventPoster(event)
    }

    private func phaseValues(_ phase: ScrollPhase) -> (scroll: Int64, momentum: Int64) {
        switch phase {
        case .began: return (1, 0)
        case .changed: return (2, 0)
        case .ended: return (4, 0)
        case .momentumBegan: return (0, 1)
        case .momentumChanged: return (0, 2)
        case .momentumEnded: return (0, 3)
        }
    }

    private func postKey(virtualKey: CGKeyCode, keyDown: Bool, flags: CGEventFlags) -> Bool {
        guard let event = CGEvent(
            keyboardEventSource: source,
            virtualKey: virtualKey,
            keyDown: keyDown
        ) else { return false }
        event.flags = flags
        eventPoster(event)
        return true
    }

    private func eventFlags(_ modifiers: [String]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for modifier in modifiers {
            switch modifier {
            case "cmd": flags.insert(.maskCommand)
            case "ctrl": flags.insert(.maskControl)
            case "option": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default: preconditionFailure("modifier was not prevalidated")
            }
        }
        return flags
    }

    private func scheduleFocusProbe(requestID: String) {
        focusLock.lock()
        focusGeneration &+= 1
        let generation = focusGeneration
        let initial = initialFocusDelayMs
        let settle = settleFocusDelayMs
        focusLock.unlock()
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(initial)) { [weak self] in
            self?.resolveFocus(
                requestID: requestID,
                generation: generation,
                settleDelayMs: settle
            )
        }
    }

    private func cancelFocusProbe() {
        focusLock.lock()
        focusGeneration &+= 1
        focusLock.unlock()
    }

    private func isCurrentFocusProbe(_ generation: UInt64) -> Bool {
        focusLock.lock()
        defer { focusLock.unlock() }
        return generation == focusGeneration
    }

    private func resolveFocus(requestID: String, generation: UInt64, settleDelayMs: Int) {
        guard isCurrentFocusProbe(generation) else { return }
        guard isTrusted else {
            reject(reason: "accessibility-denied")
            return
        }
        let cursorKind = cursorKindProvider()
        let sample = focusSampler()
        if sample.editability != "editable", settleDelayMs > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(settleDelayMs)) { [weak self] in
                guard let self, self.isCurrentFocusProbe(generation) else { return }
                guard self.isTrusted else {
                    self.reject(reason: "accessibility-denied")
                    return
                }
                self.emitFocus(
                    requestID: requestID,
                    sample: self.focusSampler(),
                    cursorKind: self.cursorKindProvider()
                )
            }
            return
        }
        emitFocus(requestID: requestID, sample: sample, cursorKind: cursorKind)
    }

    private func emitFocus(requestID: String, sample: DesktopFocusSample, cursorKind: String) {
        let source = sample.editability == "ambiguous" && cursorKind == "ibeam"
            ? "cursor-tap-heuristic"
            : sample.source
        var event: [String: Any] = [
            "type": "text-focus",
            "focusRequestId": requestID,
            "editability": sample.editability,
            "secure": sample.secure,
            "source": source,
            "cursorKind": cursorKind,
        ]
        if let role = sample.role { event["role"] = role }
        if let subrole = sample.subrole { event["subrole"] = subrole }
        emitJSON(event)
    }

    private func reset() {
        // Before anything else: a viewer that hands back control mid-drag must not leave a button
        // stuck down on the Mac.
        releaseHeldButton()
        if scrollActive { scroll(dx: 0, dy: 0, phase: .ended) }
        scrollActive = false
        scrollRemainderX = 0
        scrollRemainderY = 0
        cursorPosition = nil
        cursorActivityLock.lock()
        lastCursorMoveTime = 0
        cursorActivityLock.unlock()
    }

    private func reject(sequence: UInt32? = nil, reason: String) {
        var event: [String: Any] = ["type": "input-rejected", "reason": reason]
        if let sequence { event["sequence"] = sequence }
        emitJSON(event)
    }

    private func emitJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else {
            FileHandle.standardError.write(Data("grid-encoder: control event encode failed\n".utf8))
            return
        }
        emit(data)
    }
}

private struct DesktopControlCommand: Decodable {
    struct Key: Decodable {
        let code: String
        let modifiers: [String]
    }

    let type: String
    let revision: UInt64?
    let dx: Double?
    let dy: Double?
    let x: Double?
    let y: Double?
    let button: String?
    let focusRequestId: String?
    let phase: String?
    let sequence: UInt32?
    let keys: [Key]?
    let initialFocusDelayMs: Int?
    let settleFocusDelayMs: Int?
}

struct DesktopFocusSample: Equatable {
    let editability: String
    let secure: Bool
    let source: String
    let role: String?
    let subrole: String?

    init(
        editability: String,
        secure: Bool,
        source: String,
        role: String? = nil,
        subrole: String? = nil
    ) {
        self.editability = editability
        self.secure = secure
        self.source = source
        self.role = role
        self.subrole = subrole
    }
}

enum DesktopFocusClassifier {
    private static let editableRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField",
    ]
    private static let editableSubroles: Set<String> = ["AXSearchField", "AXSecureTextField"]
    private static let nonEditableRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXImage", "AXLink", "AXMenu", "AXMenuBar",
        "AXMenuButton", "AXMenuItem", "AXPopUpButton", "AXRadioButton", "AXSlider",
        "AXStaticText", "AXSwitch", "AXToolbar",
    ]

    static func classify(role: String?, subrole: String?) -> DesktopFocusSample {
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        let editability: String
        if role.map(editableRoles.contains) == true || subrole.map(editableSubroles.contains) == true {
            editability = "editable"
        } else if role.map(nonEditableRoles.contains) == true {
            editability = "non-editable"
        } else {
            editability = "ambiguous"
        }
        return DesktopFocusSample(
            editability: editability,
            secure: secure,
            source: "accessibility",
            role: role,
            subrole: subrole
        )
    }
}

private enum DesktopFocusResolver {
    static func current() -> DesktopFocusSample {
        guard AXIsProcessTrusted() else {
            return DesktopFocusSample(editability: "ambiguous", secure: false, source: "none")
        }
        if let app = NSWorkspace.shared.frontmostApplication,
           let focused = focusedElement(from: AXUIElementCreateApplication(app.processIdentifier)) {
            return classify(focused)
        }
        guard let focused = focusedElement(from: AXUIElementCreateSystemWide()) else {
            return DesktopFocusSample(editability: "ambiguous", secure: false, source: "none")
        }
        return classify(focused)
    }

    private static func focusedElement(from root: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            root,
            kAXFocusedUIElementAttribute as CFString,
            &value
        ) == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func classify(_ element: AXUIElement) -> DesktopFocusSample {
        DesktopFocusClassifier.classify(
            role: stringAttribute(kAXRoleAttribute as CFString, from: element),
            subrole: stringAttribute(kAXSubroleAttribute as CFString, from: element)
        )
    }

    private static func stringAttribute(_ name: CFString, from element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
        return value as? String
    }
}

private enum KeyCodeMap {
    static func lookup(_ code: String) -> CGKeyCode? { table[code] }

    private static let table: [String: CGKeyCode] = [
        "escape": CGKeyCode(kVK_Escape), "tab": CGKeyCode(kVK_Tab),
        "return": CGKeyCode(kVK_Return), "delete": CGKeyCode(kVK_Delete),
        "space": CGKeyCode(kVK_Space), "left": CGKeyCode(kVK_LeftArrow),
        "right": CGKeyCode(kVK_RightArrow), "up": CGKeyCode(kVK_UpArrow),
        "down": CGKeyCode(kVK_DownArrow),
        "ansi-A": CGKeyCode(kVK_ANSI_A), "ansi-B": CGKeyCode(kVK_ANSI_B),
        "ansi-C": CGKeyCode(kVK_ANSI_C), "ansi-D": CGKeyCode(kVK_ANSI_D),
        "ansi-E": CGKeyCode(kVK_ANSI_E), "ansi-F": CGKeyCode(kVK_ANSI_F),
        "ansi-G": CGKeyCode(kVK_ANSI_G), "ansi-H": CGKeyCode(kVK_ANSI_H),
        "ansi-I": CGKeyCode(kVK_ANSI_I), "ansi-J": CGKeyCode(kVK_ANSI_J),
        "ansi-K": CGKeyCode(kVK_ANSI_K), "ansi-L": CGKeyCode(kVK_ANSI_L),
        "ansi-M": CGKeyCode(kVK_ANSI_M), "ansi-N": CGKeyCode(kVK_ANSI_N),
        "ansi-O": CGKeyCode(kVK_ANSI_O), "ansi-P": CGKeyCode(kVK_ANSI_P),
        "ansi-Q": CGKeyCode(kVK_ANSI_Q), "ansi-R": CGKeyCode(kVK_ANSI_R),
        "ansi-S": CGKeyCode(kVK_ANSI_S), "ansi-T": CGKeyCode(kVK_ANSI_T),
        "ansi-U": CGKeyCode(kVK_ANSI_U), "ansi-V": CGKeyCode(kVK_ANSI_V),
        "ansi-W": CGKeyCode(kVK_ANSI_W), "ansi-X": CGKeyCode(kVK_ANSI_X),
        "ansi-Y": CGKeyCode(kVK_ANSI_Y), "ansi-Z": CGKeyCode(kVK_ANSI_Z),
        "ansi-0": CGKeyCode(kVK_ANSI_0), "ansi-1": CGKeyCode(kVK_ANSI_1),
        "ansi-2": CGKeyCode(kVK_ANSI_2), "ansi-3": CGKeyCode(kVK_ANSI_3),
        "ansi-4": CGKeyCode(kVK_ANSI_4), "ansi-5": CGKeyCode(kVK_ANSI_5),
        "ansi-6": CGKeyCode(kVK_ANSI_6), "ansi-7": CGKeyCode(kVK_ANSI_7),
        "ansi-8": CGKeyCode(kVK_ANSI_8), "ansi-9": CGKeyCode(kVK_ANSI_9),
        "ansi-comma": CGKeyCode(kVK_ANSI_Comma),
        "ansi-period": CGKeyCode(kVK_ANSI_Period),
        "ansi-slash": CGKeyCode(kVK_ANSI_Slash),
        "ansi-semicolon": CGKeyCode(kVK_ANSI_Semicolon),
        "ansi-quote": CGKeyCode(kVK_ANSI_Quote),
        "ansi-leftbracket": CGKeyCode(kVK_ANSI_LeftBracket),
        "ansi-rightbracket": CGKeyCode(kVK_ANSI_RightBracket),
        "ansi-backslash": CGKeyCode(kVK_ANSI_Backslash),
        "ansi-minus": CGKeyCode(kVK_ANSI_Minus),
        "ansi-equal": CGKeyCode(kVK_ANSI_Equal),
        "ansi-grave": CGKeyCode(kVK_ANSI_Grave),
    ]
}
