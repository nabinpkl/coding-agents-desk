import AppKit
import CoreGraphics
import Foundation
import os

// Mission Control Spaces. Two responsibilities:
//
//   - Enumeration. SkyLight private API. Probes the SLS-prefixed names
//     (yabai's 2026 convention) first; falls back to the CGS-prefixed
//     legacy aliases. Both resolve to the same symbols today; the
//     fallback survives Apple dropping the legacy aliases.
//
//   - Switching. Forwards iPhone-side swipe phases (Began / Changed /
//     Ended) into synthesised dock-swipe CGEvents, one per phase. The
//     Dock animates the Spaces transition according to the progress
//     stream and commits (or snaps back) at Ended based on progress +
//     velocity. This mirrors what the trackpad's physical 3-finger
//     swipe produces; the iPhone is just driving the same event
//     stream over the network.
//
// The direct setter (CGSManagedDisplaySetCurrentSpace) is also bound for
// env-gated diagnostics. It is not the default because Dock owns the
// full Spaces transition state; outside Dock context the setter can
// report success while window visibility or focus only partially
// converges. Use AGENTDESK_SPACE_SWITCH_MODE=direct-set to test it.
//
// Space `id64`: monotonic uint64 assigned at Space creation, never
// reused. Not the "Desktop N" ordinal Mission Control shows. Carry
// `id64` for identity, compute the ordinal yourself (claude-copilot
// learning).
//
// Space `type`: 0 = user (Desktop N), 4 = fullscreen-app. User Spaces
// only feed the dot carousel.

private let skylightPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"

private struct SkyLight {
    typealias MainConnectionIDFn = @convention(c) () -> Int32
    typealias GetActiveSpaceFn = @convention(c) (Int32) -> UInt64
    typealias CopyManagedDisplaySpacesFn = @convention(c) (Int32) -> CFArray?
    typealias ManagedDisplaySetCurrentSpaceFn = @convention(c) (Int32, CFString, UInt64) -> Void

    let mainConnectionID: MainConnectionIDFn
    let getActiveSpace: GetActiveSpaceFn
    let copyManagedDisplaySpaces: CopyManagedDisplaySpacesFn
    let managedDisplaySetCurrentSpace: ManagedDisplaySetCurrentSpaceFn?

    static let shared: SkyLight? = {
        guard let handle = dlopen(skylightPath, RTLD_NOW) else { return nil }
        func resolve(_ slsName: String, _ cgsName: String) -> UnsafeMutableRawPointer? {
            dlsym(handle, slsName) ?? dlsym(handle, cgsName)
        }
        guard
            let m1 = resolve("SLSMainConnectionID", "CGSMainConnectionID"),
            let m2 = resolve("SLSGetActiveSpace", "CGSGetActiveSpace"),
            let m3 = resolve("SLSCopyManagedDisplaySpaces", "CGSCopyManagedDisplaySpaces")
        else { return nil }
        let setter = resolve("SLSManagedDisplaySetCurrentSpace", "CGSManagedDisplaySetCurrentSpace")
        return SkyLight(
            mainConnectionID: unsafeBitCast(m1, to: MainConnectionIDFn.self),
            getActiveSpace: unsafeBitCast(m2, to: GetActiveSpaceFn.self),
            copyManagedDisplaySpaces: unsafeBitCast(m3, to: CopyManagedDisplaySpacesFn.self),
            managedDisplaySetCurrentSpace: setter.map {
                unsafeBitCast($0, to: ManagedDisplaySetCurrentSpaceFn.self)
            }
        )
    }()
}

// Reverse-engineered CGEventField indices for the dock-swipe synthesis
// path. Names mirror the constants InstantSpaceSwitcher / iss /
// Karabiner-Elements expose. Stable since 3-finger swipe shipped in
// 10.11; if Apple ever changes them the symptom is "swipe posts but
// nothing happens" and the smoke for that is HITL.
private enum DockSwipeField {
    static let cgsEventType = CGEventField(rawValue: 55)!
    static let gestureHIDType = CGEventField(rawValue: 110)!
    static let gestureSwipeMotion = CGEventField(rawValue: 123)!
    static let gestureSwipeProgress = CGEventField(rawValue: 124)!
    static let gestureSwipeVelocityX = CGEventField(rawValue: 129)!
    static let gestureSwipeVelocityY = CGEventField(rawValue: 130)!
    static let gesturePhase = CGEventField(rawValue: 132)!
}

private enum DockSwipeConstant {
    static let dockControl: Int64 = 30
    static let dockSwipeHIDType: Int64 = 23
    static let motionHorizontal: Int64 = 1
}

// CGSGesturePhase mapping for the wire-level SwipePhase. Began=1,
// Changed=2, Ended=4, Cancelled=8 - matches the values trackpads
// natively send.
private func cgsPhase(_ phase: NormalizedInput.SwipePhase) -> Int64 {
    switch phase {
    case .began:     return 1
    case .changed:   return 2
    case .ended:     return 4
    case .cancelled: return 8
    }
}

final class SpacesProvider {
    typealias EventPoster = (CGEvent) -> Void
    typealias DirectSpaceSetter = (_ displayId: String, _ spaceId: UInt64) -> Bool

    private let logger = Logger(subsystem: Config.logSubsystem, category: "spaces")
    private let eventPoster: EventPoster
    private let spaceSwitchMode: Config.SpaceSwitchMode
    private let currentStateOverride: (() -> DesktopState?)?
    private let directSpaceSetter: DirectSpaceSetter
    private let selectedDisplayIdProvider: () -> String?
    // Dedicated serial queue for tap-to-jump chains. We can't run the
    // chain on InputDispatcher's queue because multi-step switching can
    // do private-API verification or Dock event chains, and that would
    // backpressure cursor moves and clicks for the duration of the jump.
    // Separate queue keeps the input stream flowing and still serializes
    // multiple overlapping jumps.
    private let switchQueue = DispatchQueue(
        label: "com.example.agentdesk.agentdesk.spaces-switch",
        qos: .userInteractive
    )
    // Inter-cycle gap. Live HITL testing showed Dock accepts immediate
    // Began / Changed / Ended cycles for multi-desktop jumps, so keep
    // this at zero for the fastest possible tap-to-jump path. Bump if
    // a future macOS build starts merging or dropping commits.
    private let interCycleGapMs: UInt32 = 0
    private let directSetVerificationDelayUs: useconds_t = 100_000

    init(
        eventPoster: @escaping EventPoster = { $0.post(tap: .cgSessionEventTap) },
        spaceSwitchMode: Config.SpaceSwitchMode = Config.spaceSwitchMode,
        selectedDisplayIdProvider: @escaping () -> String? = { nil },
        currentStateProvider: (() -> DesktopState?)? = nil,
        directSpaceSetter: DirectSpaceSetter? = nil
    ) {
        self.eventPoster = eventPoster
        self.spaceSwitchMode = spaceSwitchMode
        self.selectedDisplayIdProvider = selectedDisplayIdProvider
        self.currentStateOverride = currentStateProvider
        self.directSpaceSetter = directSpaceSetter ?? SpacesProvider.setCurrentSpaceDirectly
    }

    func current() -> DesktopState? {
        guard let sl = SkyLight.shared else {
            logger.error("SkyLight private framework not loadable")
            return nil
        }
        let cid = sl.mainConnectionID()
        let activeId = sl.getActiveSpace(cid)

        guard let arrRef = sl.copyManagedDisplaySpaces(cid) else {
            logger.error("CopyManagedDisplaySpaces returned null")
            return nil
        }
        let cfArr = Unmanaged<CFArray>.fromOpaque(
            Unmanaged.passUnretained(arrRef).toOpaque()
        ).takeUnretainedValue()
        guard let displaysRaw = cfArr as? [[String: Any]] else {
            logger.error("CopyManagedDisplaySpaces returned non-array structure")
            return nil
        }

        var displays: [DisplayMetadata] = []
        var spaces: [SpaceMetadata] = []
        var activeDisplayId: String?
        var activeSpaceId: UInt64?

        let displayInfoById = HostDisplayResolver.displaysBySkyLightId()

        for entry in displaysRaw {
            guard let displayUUID = entry["Display Identifier"] as? String else { continue }
            let info = displayInfoById[displayUUID]
            let bounds = info?.bounds ?? CGDisplayBounds(CGMainDisplayID())
            displays.append(DisplayMetadata(
                id: displayUUID,
                label: info?.label ?? "Display \(displays.count + 1)",
                isMain: info?.isMain ?? false,
                originX: Float(bounds.origin.x),
                originY: Float(bounds.origin.y),
                widthPoints: Float(bounds.width),
                heightPoints: Float(bounds.height)
            ))

            guard let displaySpaces = entry["Spaces"] as? [[String: Any]] else { continue }
            var userSpaceIndex = 0
            for s in displaySpaces {
                guard let idAny = s["id64"], let id = (idAny as? NSNumber)?.uint64Value else { continue }
                let type = (s["type"] as? Int) ?? ((s["type"] as? NSNumber)?.intValue ?? 0)
                let idx: Int?
                if type == 0 {
                    idx = userSpaceIndex
                    userSpaceIndex += 1
                } else {
                    idx = nil
                }
                spaces.append(SpaceMetadata(id: id, displayId: displayUUID, index: idx, type: type))
                if id == activeId {
                    activeSpaceId = id
                    activeDisplayId = displayUUID
                }
            }
        }

        // ADR-0009: snapshot the current cursor position so the client
        // can seed its dead-reckoning model from the real location
        // instead of display center, eliminating the startup drift.
        let cursorLoc = CGEvent(source: nil)?.location
        return DesktopState(
            displays: displays,
            spaces: spaces,
            activeDisplayId: activeDisplayId,
            selectedDisplayId: selectedDisplayIdProvider() ?? activeDisplayId,
            activeSpaceId: activeSpaceId,
            cursorX: cursorLoc.map { Float($0.x) },
            cursorY: cursorLoc.map { Float($0.y) }
        )
    }

    // Forward one frame of the iPhone-side swipe gesture into the Dock.
    // The phase / progress / velocity all come from the wire as the
    // iPhone driver streams them; the Dock interprets the sequence
    // exactly the same as a trackpad-native 3-finger swipe.
    //
    // Progress: signed [-1, 1] from the client; negative = swipe-left,
    // positive = swipe-right. We pass it through directly. A literal
    // zero progress on a Changed phase reads as "no swipe in progress"
    // and Dock drops the event, so the client nudges to FLT_MIN-sized
    // at minimum on Began / Changed.
    //
    // Velocity: pts/sec from the iPhone's UIPanGestureRecognizer;
    // Dock uses it (together with the final progress) to decide
    // commit-vs-snap-back at Ended. A high velocity (~2000+) plus low
    // progress still commits; a low velocity at low progress snaps
    // back; the same heuristic the trackpad path uses.
    // Tap-to-jump entry point. Client sends a single .switchSpaceStep
    // frame. The default backend expands it into |delta|
    // Began/Changed/Ended Dock-swipe cycles. The experimental direct-set
    // backend resolves the target user Space and asks SkyLight to make
    // that Space current in one call, falling back to Dock-swipe if the
    // private path cannot prove the active Space changed.
    func commitStep(delta: Int) {
        guard delta != 0 else { return }
        switchQueue.async { [weak self] in
            guard let self else { return }
            switch self.spaceSwitchMode {
            case .dockSwipe:
                self.commitStepViaDockSwipe(delta: delta)
            case .directSet:
                if !self.commitStepViaDirectSet(delta: delta) {
                    self.logger.notice("direct-set space switch fell back to dock-swipe")
                    self.commitStepViaDockSwipe(delta: delta)
                }
            }
        }
    }

    private func commitStepViaDockSwipe(delta: Int) {
        let steps = abs(delta)
        let dir: Float = delta > 0 ? 1.0 : -1.0
        let gapMs = interCycleGapMs
        for i in 0..<steps {
            postDockSwipeFrame(phase: .began, progress: 0, velocityX: 0)
            postDockSwipeFrame(
                phase: .changed, progress: dir * 0.5, velocityX: dir * 1500
            )
            postDockSwipeFrame(
                phase: .ended, progress: dir, velocityX: dir * 2000
            )
            if gapMs > 0, i < steps - 1 {
                usleep(gapMs * 1000)
            }
        }
    }

    @discardableResult
    private func commitStepViaDirectSet(delta: Int) -> Bool {
        guard let state = resolvedCurrentState() else {
            logger.error("direct-set unavailable: DesktopState is nil")
            return false
        }
        guard let activeDisplayId = state.activeDisplayId, let activeSpaceId = state.activeSpaceId else {
            logger.error("direct-set unavailable: active display or active Space missing")
            return false
        }

        let userSpaces = state.spaces
            .filter { $0.displayId == activeDisplayId && $0.type == 0 && $0.index != nil }
            .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
        guard let activeOrdinal = userSpaces.firstIndex(where: { $0.id == activeSpaceId }) else {
            logger.error("direct-set unavailable: active Space is not a user desktop")
            return false
        }

        let targetOrdinal = activeOrdinal + delta
        guard userSpaces.indices.contains(targetOrdinal) else {
            logger.notice(
                "direct-set no-op: requested target ordinal \(targetOrdinal, privacy: .public) outside \(userSpaces.count, privacy: .public) user Spaces"
            )
            return true
        }

        let target = userSpaces[targetOrdinal]
        logger.notice(
            "direct-set attempt display=\(activeDisplayId, privacy: .public) activeSpace=\(activeSpaceId, privacy: .public) activeOrdinal=\(activeOrdinal, privacy: .public) delta=\(delta, privacy: .public) targetSpace=\(target.id, privacy: .public) targetOrdinal=\(targetOrdinal, privacy: .public)"
        )

        guard directSpaceSetter(activeDisplayId, target.id) else {
            logger.error("direct-set private setter unavailable or rejected")
            return false
        }

        if resolvedCurrentState()?.activeSpaceId == target.id {
            logger.notice("direct-set verified immediately")
            return true
        }

        usleep(directSetVerificationDelayUs)
        guard resolvedCurrentState()?.activeSpaceId == target.id else {
            logger.error("direct-set did not verify after delayed state read")
            return false
        }
        logger.notice("direct-set verified after delayed state read")
        return true
    }

    private func resolvedCurrentState() -> DesktopState? {
        currentStateOverride?() ?? current()
    }

    private static func setCurrentSpaceDirectly(displayId: String, spaceId: UInt64) -> Bool {
        guard let sl = SkyLight.shared, let setter = sl.managedDisplaySetCurrentSpace else {
            return false
        }
        setter(sl.mainConnectionID(), displayId as CFString, spaceId)
        return true
    }

    // Test-only barrier: blocks until any in-flight commitStep chain
    // on switchQueue has drained. Production code never calls this.
    func _drainSwitchQueueForTests() {
        switchQueue.sync {}
    }

    @discardableResult
    func postDockSwipeFrame(
        phase: NormalizedInput.SwipePhase,
        progress: Float,
        velocityX: Float
    ) -> Bool {
        guard let event = CGEvent(source: nil) else {
            logger.error("CGEvent(source:nil) returned nil")
            return false
        }
        event.setIntegerValueField(DockSwipeField.cgsEventType, value: DockSwipeConstant.dockControl)
        event.setIntegerValueField(DockSwipeField.gestureHIDType, value: DockSwipeConstant.dockSwipeHIDType)
        event.setIntegerValueField(DockSwipeField.gesturePhase, value: cgsPhase(phase))
        event.setIntegerValueField(DockSwipeField.gestureSwipeMotion, value: DockSwipeConstant.motionHorizontal)
        event.setDoubleValueField(DockSwipeField.gestureSwipeProgress, value: Double(progress))
        event.setDoubleValueField(DockSwipeField.gestureSwipeVelocityX, value: Double(velocityX))
        event.setDoubleValueField(DockSwipeField.gestureSwipeVelocityY, value: Double(velocityX))
        eventPoster(event)
        return true
    }
}

struct HostDisplayInfo: Equatable {
    let skyLightId: String
    let cgDisplayId: CGDirectDisplayID
    let label: String
    let isMain: Bool
    let bounds: CGRect
}

enum HostDisplayResolver {
    static func displaysBySkyLightId() -> [String: HostDisplayInfo] {
        var result: [String: HostDisplayInfo] = [:]
        let mainDisplayID = CGMainDisplayID()
        let screenNumberKey = NSDeviceDescriptionKey("NSScreenNumber")
        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[screenNumberKey] as? NSNumber else {
                continue
            }
            let cgDisplayId = CGDirectDisplayID(number.uint32Value)
            guard let skyLightId = skyLightId(for: cgDisplayId) else { continue }
            let bounds = CGDisplayBounds(cgDisplayId)
            result[skyLightId] = HostDisplayInfo(
                skyLightId: skyLightId,
                cgDisplayId: cgDisplayId,
                label: screen.localizedName,
                isMain: cgDisplayId == mainDisplayID,
                bounds: bounds
            )
        }
        return result
    }

    static func displayID(forSkyLightId skyLightId: String?) -> CGDirectDisplayID? {
        guard let skyLightId else { return nil }
        return displaysBySkyLightId()[skyLightId]?.cgDisplayId
    }

    static func bounds(forSkyLightId skyLightId: String?) -> CGRect {
        if let skyLightId, let info = displaysBySkyLightId()[skyLightId] {
            return info.bounds
        }
        return CGDisplayBounds(CGMainDisplayID())
    }

    private static func skyLightId(for displayID: CGDirectDisplayID) -> String? {
        guard let uuid = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue() else {
            return nil
        }
        return CFUUIDCreateString(nil, uuid) as String
    }
}

final class DisplaySelectionStore: @unchecked Sendable {
    private let lock = NSLock()
    private var selected: String?

    var selectedDisplayId: String? {
        lock.lock()
        defer { lock.unlock() }
        return selected
    }

    @discardableResult
    func select(_ displayId: String?, availableDisplayIds: Set<String>? = nil) -> Bool {
        if let displayId, let availableDisplayIds, !availableDisplayIds.contains(displayId) {
            return false
        }
        lock.lock()
        defer { lock.unlock() }
        guard selected != displayId else { return false }
        selected = displayId
        return true
    }

    @discardableResult
    func selectDefaultIfNeeded(_ displayId: String?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard selected == nil, let displayId else { return false }
        selected = displayId
        return true
    }

    func selectedBounds() -> CGRect {
        HostDisplayResolver.bounds(forSkyLightId: selectedDisplayId)
    }
}
