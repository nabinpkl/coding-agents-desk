import Foundation
import os

// SkyLight (private CoreGraphics-Services) binding for Mission Control
// Spaces. Direct synthesised Ctrl+Arrow keystrokes turned out to depend
// on System Settings (Mission Control "Move left/right a space" must be
// enabled), which made the v0 acceptance gesture fragile on stock
// macOS installs. This module talks to the same private surface every
// serious window manager (Yabai, Amethyst, Rectangle Pro) uses, so
// switching does not depend on user settings.
//
// Symbol provenance: validated on Darwin 25 in claude-copilot
// (mac_core/cgs.py). Stable on this surface since macOS 10.10 (2014)
// when WindowServer became SkyLight. Each macOS major bump is a risk
// surface; the smoke test in SpacesProviderTests catches regressions.
//
// Space `id64` semantics (per claude-copilot/mac_workspace/learnings):
// it is WindowServer's monotonic uint64 assigned at Space creation,
// never reused. The "Desktop 1, 2, ..." names Mission Control shows
// are ordinal positions in the per-display Spaces list, computed live.
// Carry `id64` for identity, compute the ordinal yourself for display.
//
// Space `type` field: 0 = user (Desktop N), 4 = fullscreen-app Space.
// The dots band counts user Spaces only; fullscreen Spaces would
// otherwise pollute the carousel.

private let skylightPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"

private struct SkyLight {
    typealias MainConnectionIDFn = @convention(c) () -> Int32
    typealias GetActiveSpaceFn = @convention(c) (Int32) -> UInt64
    typealias CopyManagedDisplaySpacesFn = @convention(c) (Int32) -> CFArray?
    typealias ManagedDisplaySetCurrentSpaceFn = @convention(c) (Int32, CFString, UInt64) -> Int32

    let mainConnectionID: MainConnectionIDFn
    let getActiveSpace: GetActiveSpaceFn
    let copyManagedDisplaySpaces: CopyManagedDisplaySpacesFn
    let managedDisplaySetCurrentSpace: ManagedDisplaySetCurrentSpaceFn

    static let shared: SkyLight? = {
        guard let handle = dlopen(skylightPath, RTLD_NOW) else { return nil }
        guard
            let m1 = dlsym(handle, "CGSMainConnectionID"),
            let m2 = dlsym(handle, "CGSGetActiveSpace"),
            let m3 = dlsym(handle, "CGSCopyManagedDisplaySpaces"),
            let m4 = dlsym(handle, "CGSManagedDisplaySetCurrentSpace")
        else { return nil }
        return SkyLight(
            mainConnectionID: unsafeBitCast(m1, to: MainConnectionIDFn.self),
            getActiveSpace: unsafeBitCast(m2, to: GetActiveSpaceFn.self),
            copyManagedDisplaySpaces: unsafeBitCast(m3, to: CopyManagedDisplaySpacesFn.self),
            managedDisplaySetCurrentSpace: unsafeBitCast(m4, to: ManagedDisplaySetCurrentSpaceFn.self)
        )
    }()
}

// Pure plan struct so the index-walk logic is testable without a live
// SkyLight binding. SpacesProvider.switchSpace composes
// `planSwitch(from:direction:)` with the actual setter call.
struct SpaceSwitchPlan: Equatable {
    let displayId: String
    let targetSpaceId: UInt64
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
            logger.error("CGSCopyManagedDisplaySpaces returned null")
            return nil
        }
        // Bridged via takeRetainedValue: the CGSCopy* family follows the
        // Create Rule and we own the +1 retain.
        let cfArr = Unmanaged<CFArray>.fromOpaque(
            Unmanaged.passUnretained(arrRef).toOpaque()
        ).takeUnretainedValue()
        guard let displaysRaw = cfArr as? [[String: Any]] else {
            logger.error("CGSCopyManagedDisplaySpaces returned non-array structure")
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
        guard let sl = SkyLight.shared else { return false }
        guard let state = current(),
              let plan = Self.planSwitch(from: state, direction: direction) else {
            logger.notice("switchSpace no-op: no neighbour Space in direction \(String(describing: direction), privacy: .public)")
            return false
        }
        let cid = sl.mainConnectionID()
        let err = sl.managedDisplaySetCurrentSpace(cid, plan.displayId as CFString, plan.targetSpaceId)
        if err != 0 {
            logger.error("CGSManagedDisplaySetCurrentSpace failed err=\(err, privacy: .public)")
            return false
        }
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
