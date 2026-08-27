// The SkyLight private-API binding, and nothing else.
//
// Split out of `SpacesProvider.swift` so it can be compiled into BOTH the host app and the
// standalone `grid-encoder` helper (see `tools/build-grid-encoder.sh`). The helper needs the same
// desktop and per-window Space membership reads the host does, and duplicating a private-API
// binding is how the two drift apart on the next macOS release. That file's own rule -- "keep the
// private-API surface in one place so drift has one owner" -- is the reason this is shared source
// rather than a second copy.
//
// Dependency-free ON PURPOSE: Foundation and CoreGraphics only. No AppKit, no `AgentDeskWire`, no
// host types. The helper is a bare `swiftc -O` binary with no app bundle and no package graph, so
// anything imported here has to be available to it too.
//
// Space `id64`: monotonic uint64 assigned at Space creation, never reused. Not the "Desktop N"
// ordinal Mission Control shows. Carry `id64` for identity, compute the ordinal yourself.
//
// Space `type`: 0 = user (Desktop N), 4 = fullscreen-app.

import CoreGraphics
import Foundation

let skylightPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"

typealias SkyLightConnectionCallback = @convention(c) (
    UInt32,
    UnsafeMutableRawPointer?,
    Int,
    UnsafeMutableRawPointer?,
    Int32
) -> Void

struct SkyLight {
    typealias MainConnectionIDFn = @convention(c) () -> Int32
    typealias GetActiveSpaceFn = @convention(c) (Int32) -> UInt64
    typealias CopyManagedDisplaySpacesFn = @convention(c) (Int32) -> CFArray?
    typealias ManagedDisplaySetCurrentSpaceFn = @convention(c) (Int32, CFString, UInt64) -> Void
    typealias RegisterConnectionNotifyProcFn = @convention(c) (
        Int32,
        SkyLightConnectionCallback,
        UInt32,
        UnsafeMutableRawPointer?
    ) -> CGError
    // Per-window Space membership. Same binding, one extra symbol — the dock-enrichment audit
    // (ADR-0054) needs to know which Desktop each window lives on. Optional so a macOS build that
    // drops it degrades the enrichment to ungrouped rather than failing the whole binding.
    typealias CopySpacesForWindowsFn = @convention(c) (Int32, Int32, CFArray) -> CFArray?
    typealias MoveWindowsToManagedSpaceFn = @convention(c) (Int32, CFArray, UInt64) -> Void

    let mainConnectionID: MainConnectionIDFn
    let getActiveSpace: GetActiveSpaceFn
    let copyManagedDisplaySpaces: CopyManagedDisplaySpacesFn
    let managedDisplaySetCurrentSpace: ManagedDisplaySetCurrentSpaceFn?
    let copySpacesForWindows: CopySpacesForWindowsFn?
    let moveWindowsToManagedSpace: MoveWindowsToManagedSpaceFn?
    let registerConnectionNotifyProc: RegisterConnectionNotifyProcFn?

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
        let winSpaces = resolve("SLSCopySpacesForWindows", "CGSCopySpacesForWindows")
        let moveWindows = resolve("SLSMoveWindowsToManagedSpace", "CGSMoveWindowsToManagedSpace")
        let registerNotify = resolve("SLSRegisterConnectionNotifyProc", "CGSRegisterConnectionNotifyProc")
        return SkyLight(
            mainConnectionID: unsafeBitCast(m1, to: MainConnectionIDFn.self),
            getActiveSpace: unsafeBitCast(m2, to: GetActiveSpaceFn.self),
            copyManagedDisplaySpaces: unsafeBitCast(m3, to: CopyManagedDisplaySpacesFn.self),
            managedDisplaySetCurrentSpace: setter.map {
                unsafeBitCast($0, to: ManagedDisplaySetCurrentSpaceFn.self)
            },
            copySpacesForWindows: winSpaces.map {
                unsafeBitCast($0, to: CopySpacesForWindowsFn.self)
            },
            moveWindowsToManagedSpace: moveWindows.map {
                unsafeBitCast($0, to: MoveWindowsToManagedSpaceFn.self)
            },
            registerConnectionNotifyProc: registerNotify.map {
                unsafeBitCast($0, to: RegisterConnectionNotifyProcFn.self)
            }
        )
    }()
}
