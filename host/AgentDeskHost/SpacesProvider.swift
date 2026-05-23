import CoreGraphics
import Foundation
import os

// Mission Control Spaces. Two responsibilities:
//
//   - Enumeration. SkyLight private API (CGSCopyManagedDisplaySpaces +
//     CGSGetActiveSpace + CGSMainConnectionID). Read-only, works on
//     stock macOS without SIP changes. Same surface every serious
//     window manager (Yabai, Amethyst, Rectangle Pro) uses, validated
//     in claude-copilot/mac_core/cgs.py on Darwin 25.
//
//   - Switching. Synthesised dock-swipe CGEvent (kCGSEventDockControl
//     with kIOHIDEventTypeDockSwipe and a Began -> Changed -> Ended
//     phase sequence, high horizontal velocity). The direct setter
//     CGSManagedDisplaySetCurrentSpace exists in SkyLight but only
//     accepts calls from Dock.app, which is why yabai requires SIP
//     to be disabled to inject into Dock. The gesture-synthesis path
//     produces the same end result without privileged access; it is
//     the pattern shipping in InstantSpaceSwitcher 2.0 (Apr 2026),
//     joshuarli/iss, and theo-sardin/instant-switcher.
//
// Symbol naming: Apple is migrating from the `CGS*` aliases (legacy
// from the ApplicationServices era) to the `SLS*` (SkyLight Services)
// names. Both resolve to the same SkyLight symbols today. We probe
// `SLS*` first and fall back to `CGS*` so we keep working when Apple
// eventually drops the legacy aliases.
//
// Space `id64` semantics (per claude-copilot/mac_workspace/learnings):
// monotonic uint64 assigned at Space creation, never reused. The
// "Desktop 1, 2, ..." labels Mission Control shows are ordinal
// positions in the per-display Spaces list, computed live.
//
// Space `type` field: 0 = user (Desktop N), 4 = fullscreen-app Space.
// User Spaces only feed the dot carousel and the gesture walk;
// fullscreen Spaces are skipped because Mission Control's left/right
// navigation skips them too.

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
        // SLS-prefixed lookup first (current convention as of yabai's
        // 2026 source); CGS-prefixed fallback (legacy alias still
        // present on all macOS versions through 26 / Tahoe).
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

// Pure plan struct so the index-walk logic is testable without a live
// SkyLight binding. Drives the "do we have a neighbour Space?" check
// in switchSpace; nil means we are at an edge and no gesture should
// fire.
struct SpaceSwitchPlan: Equatable {
    let displayId: String
    let targetSpaceId: UInt64
}

// Reverse-engineered CGEventField indices used by the dock-swipe
// synthesis path. Names mirror the constants InstantSpaceSwitcher /
// iss / Karabiner expose. Stable since the 3-finger swipe gesture
// shipped in 10.11; if Apple ever changes these the symptom is the
// gesture posts but nothing happens.
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
    // kCGSEventDockControl (30) is the umbrella event type the Dock
    // process listens for to drive Spaces / Mission Control transitions.
    static let dockControl: Int64 = 30
    // kIOHIDEventTypeDockSwipe (23) is the HID-side classifier the Dock
    // expects on a dock-targeted gesture.
    static let dockSwipeHIDType: Int64 = 23
    static let motionHorizontal: Int64 = 1
    // Phases match CGSGesturePhase: Began=1, Changed=2, Ended=4.
    static let phaseBegan: Int64 = 1
    static let phaseChanged: Int64 = 2
    static let phaseEnded: Int64 = 4
    // Velocity in points-per-second. ISS 2.0's default is 2000.0;
    // anything ~> 400 skips the animated swipe and produces an
    // "instant" Space switch.
    static let velocity: Double = 2000.0
}

final class SpacesProvider {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "spaces")

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

    @discardableResult
    func switchSpace(direction: NormalizedInput.SpaceDirection) -> Bool {
        // Don't fire a gesture if there is no neighbour to switch to
        // (single Space, or already at the edge). Matches macOS native
        // edge-stop behaviour and avoids the brief "swipe rejected"
        // bounce.
        guard let state = current(),
              Self.planSwitch(from: state, direction: direction) != nil else {
            logger.notice("switchSpace no-op: no neighbour Space in direction \(String(describing: direction), privacy: .public)")
            return false
        }
        return performSwitchGesture(direction: direction)
    }

    // Synthesise a 3-finger horizontal dock-swipe in three phases.
    // The Dock listens for kCGSEventDockControl events and treats a
    // Began -> Changed -> Ended sequence as a complete swipe. Setting
    // the velocity high (~2000 pt/sec) makes the Dock skip the swipe
    // animation and switch instantly. Only Accessibility permission
    // is needed (same permission the cursor / keyboard paths already
    // use); no SIP changes.
    //
    // Two events (Began + Ended) are not enough; the Dock requires the
    // Changed event in the middle or the swipe is dropped.
    @discardableResult
    func performSwitchGesture(direction: NormalizedInput.SpaceDirection) -> Bool {
        let phases: [Int64] = [
            DockSwipeConstant.phaseBegan,
            DockSwipeConstant.phaseChanged,
            DockSwipeConstant.phaseEnded,
        ]
        for phase in phases {
            guard postDockSwipe(phase: phase, direction: direction) else {
                logger.error("dock-swipe post failed at phase \(phase, privacy: .public)")
                return false
            }
        }
        return true
    }

    private func postDockSwipe(phase: Int64, direction: NormalizedInput.SpaceDirection) -> Bool {
        guard let event = CGEvent(source: nil) else { return false }
        let isRight = direction == .right
        // FLT_TRUE_MIN-sized progress nudge is what InstantSpaceSwitcher
        // empirically settled on; a literal zero progress reads as "no
        // swipe in progress" and the Dock drops the event.
        let progressNudge = Double(Float.leastNonzeroMagnitude)
        let progress = isRight ? progressNudge : -progressNudge
        let velocity = isRight ? DockSwipeConstant.velocity : -DockSwipeConstant.velocity

        event.setIntegerValueField(DockSwipeField.cgsEventType, value: DockSwipeConstant.dockControl)
        event.setIntegerValueField(DockSwipeField.gestureHIDType, value: DockSwipeConstant.dockSwipeHIDType)
        event.setIntegerValueField(DockSwipeField.gesturePhase, value: phase)
        event.setDoubleValueField(DockSwipeField.gestureSwipeProgress, value: progress)
        event.setIntegerValueField(DockSwipeField.gestureSwipeMotion, value: DockSwipeConstant.motionHorizontal)
        event.setDoubleValueField(DockSwipeField.gestureSwipeVelocityX, value: velocity)
        event.setDoubleValueField(DockSwipeField.gestureSwipeVelocityY, value: velocity)
        event.post(tap: .cgSessionEventTap)
        return true
    }

    // Pure function over DesktopState. User (type=0) Spaces only;
    // fullscreen Spaces are skipped because Mission Control's
    // left/right navigation only walks user Spaces. Edge behaviour:
    // no wrap. At index 0 a `.left` swipe is a no-op; at the last
    // index a `.right` swipe is a no-op. Matches macOS native
    // behaviour (you can't loop from Desktop 1 to Desktop N).
    static func planSwitch(
        from state: DesktopState,
        direction: NormalizedInput.SpaceDirection
    ) -> SpaceSwitchPlan? {
        guard let activeDisplayId = state.activeDisplayId,
              let activeSpaceId = state.activeSpaceId else { return nil }
        let userSpaces = state.spaces
            .filter { $0.displayId == activeDisplayId && $0.type == 0 }
            .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
        guard userSpaces.count > 1 else { return nil }
        guard let activeIdx = userSpaces.firstIndex(where: { $0.id == activeSpaceId }) else {
            return nil
        }
        let targetIdx = activeIdx + (direction == .left ? -1 : 1)
        guard targetIdx >= 0, targetIdx < userSpaces.count else { return nil }
        return SpaceSwitchPlan(
            displayId: activeDisplayId,
            targetSpaceId: userSpaces[targetIdx].id
        )
    }
}
