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
// Why not the direct setter (CGSManagedDisplaySetCurrentSpace): it is
// restricted to Dock.app, which is why yabai requires SIP partially
// disabled to inject into Dock. The gesture-synthesis path is the
// unprivileged pattern shipping in jurplel/InstantSpaceSwitcher 2.0,
// joshuarli/iss, and theo-sardin/instant-switcher; works on stock
// macOS with only the Accessibility permission we already use for
// cursor and keyboard.
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

    let mainConnectionID: MainConnectionIDFn
    let getActiveSpace: GetActiveSpaceFn
    let copyManagedDisplaySpaces: CopyManagedDisplaySpacesFn

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
        return SkyLight(
            mainConnectionID: unsafeBitCast(m1, to: MainConnectionIDFn.self),
            getActiveSpace: unsafeBitCast(m2, to: GetActiveSpaceFn.self),
            copyManagedDisplaySpaces: unsafeBitCast(m3, to: CopyManagedDisplaySpacesFn.self)
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

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "spaces")
    private let eventPoster: EventPoster

    init(eventPoster: @escaping EventPoster = { $0.post(tap: .cgSessionEventTap) }) {
        self.eventPoster = eventPoster
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

        for entry in displaysRaw {
            guard let displayUUID = entry["Display Identifier"] as? String else { continue }
            displays.append(DisplayMetadata(id: displayUUID))

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

        return DesktopState(
            displays: displays,
            spaces: spaces,
            activeDisplayId: activeDisplayId,
            activeSpaceId: activeSpaceId
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
