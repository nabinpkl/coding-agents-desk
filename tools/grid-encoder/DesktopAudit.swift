// The helper's view of Desktops and windows, as JSON.
//
// Deliberately NOT the host's `WorkspaceDesktopSnapshot`. That type lives in the host module behind
// AppKit and `AgentDeskWire`, neither of which this binary has, and the shared declaration for
// anything crossing a process boundary belongs in `agent-feed/wire/` anyway. What IS shared is the
// SkyLight binding itself (`SkyLightSymbols.swift`, compiled into both), so the private-API surface
// still has one owner.
//
// Two readers of the same OS API is not duplicated state: neither side caches, and SkyLight is the
// source of truth for both. What would be duplicated state is a snapshot passed between them and
// then re-read on one side only.
//
// The load-bearing caveat: `kCGWindowName` requires SCREEN RECORDING, not Accessibility. A process
// without it gets the full window list with every title empty, which is indistinguishable from a
// desktop full of untitled windows. Since the whole reason the sidecar wants this list is to skip
// Electron's untitled scaffolding windows and find the one real titled window, a silent empty title
// would produce a confident wrong answer. `screenRecordingTrusted` below reports it explicitly so
// the caller can refuse rather than guess.

import CoreGraphics
import Foundation

enum DesktopAudit {
    /// Whether this process can read window titles.
    ///
    /// `CGPreflightScreenCaptureAccess` is the direct question, and it does not prompt. The helper
    /// inherits the grant from whoever spawned it (host -> sidecar -> here), so this is really
    /// asking "did the chain hold", and the answer differs between a bundled sidecar and a `bun`
    /// spawned from Homebrew. Never request it: a prompt from a process with no bundle and no UI is
    /// a dialog the user cannot attribute to anything.
    static var screenRecordingTrusted: Bool { CGPreflightScreenCaptureAccess() }

    /// Every user Desktop and every window, in the shape `agent-feed/wire/desktopWindow.ts` declares.
    ///
    /// Returns a `diagnostic` instead of throwing when the binding is missing, because "this macOS
    /// dropped the symbols" and "there are no windows" must not look alike to the caller.
    static func snapshot() -> [String: Any] {
        guard let sl = SkyLight.shared else {
            return [
                "activeSpaceID": NSNull(),
                "desktops": [],
                "windows": [],
                "diagnostic": "SkyLight symbols unavailable",
                "screenRecordingTrusted": screenRecordingTrusted,
            ]
        }
        let cid = sl.mainConnectionID()
        let active = sl.getActiveSpace(cid)
        guard let raw = sl.copyManagedDisplaySpaces(cid), let displays = raw as? [[String: Any]] else {
            return [
                "activeSpaceID": NSNull(),
                "desktops": [],
                "windows": [],
                "diagnostic": "CopyManagedDisplaySpaces returned no displays",
                "screenRecordingTrusted": screenRecordingTrusted,
            ]
        }
        return [
            "activeSpaceID": String(active),
            "desktops": desktops(from: displays, active: active),
            "windows": windows(sl: sl, cid: cid),
            "diagnostic": NSNull(),
            "screenRecordingTrusted": screenRecordingTrusted,
        ]
    }

    /// User Desktops (Space type 0) with both per-display control order and Mission Control's
    /// global order. Fullscreen-app Spaces (type 4) are skipped: nothing can be moved into one.
    private static func desktops(from displays: [[String: Any]], active: UInt64) -> [[String: Any]] {
        var result: [[String: Any]] = []
        var missionControlOrdinal = 0
        for display in displays {
            let displayID = display["Display Identifier"] as? String ?? "unknown-display"
            let spaces = display["Spaces"] as? [[String: Any]] ?? []
            var ordinal = 0
            for space in spaces {
                guard let id = (space["id64"] as? NSNumber)?.uint64Value else { continue }
                let type = (space["type"] as? NSNumber)?.intValue ?? (space["type"] as? Int ?? -1)
                guard type == 0 else { continue }
                result.append([
                    // Space ids are uint64 and JSON numbers are doubles, so an id past 2^53 would
                    // quietly round on the TypeScript side. Every id crossing this boundary is a
                    // string for that reason; the sidecar compares them, it never does arithmetic.
                    "id": String(id),
                    "displayID": displayID,
                    "ordinal": ordinal,
                    "missionControlOrdinal": missionControlOrdinal,
                    "isActive": id == active,
                ])
                ordinal += 1
                missionControlOrdinal += 1
            }
        }
        return result
    }

    private static func windows(sl: SkyLight, cid: Int32) -> [[String: Any]] {
        let raw = CGWindowListCopyWindowInfo(
            [.optionAll, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] ?? []
        return raw.compactMap { info in
            guard let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { return nil }
            let owner = info[kCGWindowOwnerName as String] as? String ?? ""
            guard !owner.isEmpty else { return nil }
            let bounds = info[kCGWindowBounds as String] as? [String: Any]
            return [
                "windowID": id,
                "ownerPID": (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0,
                "ownerName": owner,
                "title": info[kCGWindowName as String] as? String ?? "",
                "spaceIDs": spaceIDs(sl: sl, cid: cid, windowID: id).map(String.init),
                "layer": (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? Int.max,
                "bounds": [
                    "x": (bounds?["X"] as? NSNumber)?.doubleValue ?? 0,
                    "y": (bounds?["Y"] as? NSNumber)?.doubleValue ?? 0,
                    "w": (bounds?["Width"] as? NSNumber)?.doubleValue ?? 0,
                    "h": (bounds?["Height"] as? NSNumber)?.doubleValue ?? 0,
                ],
            ]
        }
    }

    /// A window's Space membership. Empty when the symbol is missing or the window belongs to no
    /// managed Space; the caller treats "not exactly one Space" as unresolvable rather than
    /// guessing, because a window on every Space and a window on none look the same from here.
    static func spaceIDs(sl: SkyLight, cid: Int32, windowID: UInt32) -> [UInt64] {
        guard let copySpacesForWindows = sl.copySpacesForWindows else { return [] }
        let windows = [NSNumber(value: windowID)] as CFArray
        // 7 is the selector the host uses for "all Space kinds"; keeping the two calls identical is
        // what makes the helper's membership answer comparable to the host's.
        guard let raw = copySpacesForWindows(cid, 7, windows), let spaces = raw as? [NSNumber] else {
            return []
        }
        return spaces.map(\.uint64Value)
    }
}
