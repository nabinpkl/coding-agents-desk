import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct DesktopSpaceRecord: Equatable {
    let id: UInt64
    let type: Int
    var json: [String: Any] { ["id": String(id), "type": type] }
}

struct DesktopDisplayRecord: Equatable {
    let id: String
    let label: String
    let isMain: Bool
    let captureID: CGDirectDisplayID
    let bounds: CGRect
    let activeSpaceID: UInt64
    let spaces: [DesktopSpaceRecord]
    var json: [String: Any] {
        ["id": id, "label": label, "isMain": isMain,
         "activeSpaceId": String(activeSpaceID), "spaces": spaces.map(\.json)]
    }
}

enum DesktopSpaces {
    static func read() -> [DesktopDisplayRecord]? {
        guard let sky = SkyLight.shared,
              let raw = sky.copyManagedDisplaySpaces(sky.mainConnectionID()),
              let displays = raw as? [[String: Any]] else { return nil }
        let screens = NSScreen.screens
        var records: [DesktopDisplayRecord] = []
        for display in displays {
            guard let id = display["Display Identifier"] as? String,
                  let current = display["Current Space"] as? [String: Any],
                  let active = (current["id64"] as? NSNumber)?.uint64Value,
                  let rawSpaces = display["Spaces"] as? [[String: Any]] else { return nil }
            // During unplug SkyLight may briefly retain the old display record.
            guard let screen = screens.first(where: { screen in
                      guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
                            let uuid = CGDisplayCreateUUIDFromDisplayID(number.uint32Value)?.takeRetainedValue()
                      else { return false }
                      return CFUUIDCreateString(nil, uuid) as String == id
                  }),
                  let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            else { continue }
            var spaces: [DesktopSpaceRecord] = []
            for value in rawSpaces {
                guard let spaceID = (value["id64"] as? NSNumber)?.uint64Value,
                      spaceID > 0, let type = (value["type"] as? NSNumber)?.intValue,
                      (0...255).contains(type), !spaces.contains(where: { $0.id == spaceID }) else { return nil }
                spaces.append(DesktopSpaceRecord(id: spaceID, type: type))
            }
            guard spaces.contains(where: { $0.id == active }) else { return nil }
            records.append(DesktopDisplayRecord(
                id: id, label: screen.localizedName, isMain: number.uint32Value == CGMainDisplayID(),
                captureID: number.uint32Value, bounds: CGDisplayBounds(number.uint32Value),
                activeSpaceID: active, spaces: spaces
            ))
        }
        // Unknown SkyLight layout is unavailable, not an empty monitor inventory.
        return records.isEmpty && !screens.isEmpty ? nil : records
    }

    /// Discovery does not enumerate windows or take capture demand.
    static func catalog() -> [String: Any] {
        var displays: [[String: Any]] = []
        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
                  let uuid = CGDisplayCreateUUIDFromDisplayID(number.uint32Value)?.takeRetainedValue()
            else { return ["available": false, "displays": []] }
            displays.append(["id": CFUUIDCreateString(nil, uuid) as String,
                             "isMain": number.uint32Value == CGMainDisplayID(), "captureId": number.uint32Value])
        }
        return ["available": true, "displays": displays]
    }
}

/// OS-only navigation adapter. All methods run on the AppKit run loop.
final class DesktopSpacesController {
    typealias Reader = () -> [DesktopDisplayRecord]?
    private let captureDisplayID: String
    private let read: Reader
    private let trusted: () -> Bool
    private let post: (CGEvent) -> Void
    private let emit: ([String: Any]) -> Void
    private let captureGeometryChanged: () -> Void
    private var previous: [DesktopDisplayRecord]?
    private var revision = 0
    private var gesture: (id: String, display: DesktopDisplayRecord)?
    private var observer: DesktopSpacesObserver?

    init(
        captureDisplayID: String, read: @escaping Reader = DesktopSpaces.read,
        trusted: @escaping () -> Bool = { AXIsProcessTrusted() },
        post: @escaping (CGEvent) -> Void = { $0.post(tap: .cgSessionEventTap) },
        captureGeometryChanged: @escaping () -> Void = {},
        emit: @escaping ([String: Any]) -> Void
    ) {
        self.captureDisplayID = captureDisplayID
        self.read = read
        self.trusted = trusted
        self.post = post
        self.emit = emit
        self.captureGeometryChanged = captureGeometryChanged
    }

    func start() {
        observer = DesktopSpacesObserver(changed: { [weak self] in self?.refresh() }, failed: { [weak self] in
            self?.emit(["type": "desktop-unavailable", "reason": "navigation-unavailable"])
        })
        observer?.start()
        refresh(force: true)
    }

    func stop() {
        cancel()
        observer?.stop()
        observer = nil
    }

    func refresh(force: Bool = false) {
        guard let displays = read() else {
            cancel()
            emit(["type": "desktop-unavailable", "reason": "navigation-unavailable"])
            return
        }
        if let current = gesture,
           displays.first(where: { $0.id == current.display.id }) != current.display { cancel() }
        if let old = previous?.first(where: { $0.id == captureDisplayID }),
           let next = displays.first(where: { $0.id == captureDisplayID }),
           old.bounds != next.bounds || old.captureID != next.captureID {
            cancel()
            captureGeometryChanged()
            return
        }
        guard force || previous != displays else { return }
        previous = displays
        revision += 1
        emit(["type": "desktop-state", "revision": revision,
              "captureDisplayId": captureDisplayID, "displays": displays.map(\.json)])
        if let observer, !observer.available {
            emit(["type": "desktop-unavailable", "reason": "navigation-unavailable"])
        }
    }

    func cancel() {
        guard let current = gesture else { return }
        _ = frame(.cancelled, 0, 0, current.display)
        gesture = nil
    }

    /// False leaves keyboard/capture commands with their existing dispatcher.
    func handle(_ line: String) -> Bool {
        guard let data = line.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = value["type"] as? String else { return false }
        if type == "release-control" { cancel(); return false }
        guard ["desktop-refresh", "space-select", "space-gesture"].contains(type) else { return false }
        let requestID = (value["requestId"] ?? value["gestureId"]) as? String
        func reject(_ reason: String) {
            if let requestID {
                emit(["type": "space-result", "requestId": requestID, "status": "rejected", "reason": reason])
            } else { emit(["type": "desktop-unavailable", "reason": reason]) }
        }
        guard data.count <= DesktopInputController.maximumCommandBytes else { reject("malformed"); return true }
        if type == "desktop-refresh" { refresh(force: true); return true }
        guard let requestID, UUID(uuidString: requestID) != nil,
              let displayID = value["displayId"] as? String, displayID == captureDisplayID
        else { reject("malformed"); return true }
        guard trusted() else { reject("accessibility-denied"); return true }
        func currentDisplay() -> DesktopDisplayRecord? {
            guard let displays = read() else { reject("navigation-unavailable"); return nil }
            guard let display = displays.first(where: { $0.id == displayID })
            else { reject("display-unavailable"); return nil }
            return display
        }
        if type == "space-select" {
            guard let display = currentDisplay() else { return true }
            guard let target = value["spaceId"] as? String, let targetID = UInt64(target),
                  targetID > 0, String(targetID) == target,
                  let start = display.spaces.firstIndex(where: { $0.id == display.activeSpaceID }),
                  let end = display.spaces.firstIndex(where: { $0.id == targetID && $0.type == 0 })
            else { reject("space-unavailable"); return true }
            cancel()
            let direction: Double = end > start ? 1 : -1
            for _ in 0..<abs(end - start) {
                guard frame(.began, 0, 0, display),
                      frame(.changed, direction * 0.5, direction * 1500, display),
                      frame(.ended, direction, direction * 2000, display)
                else { _ = frame(.cancelled, 0, 0, display); reject("navigation-unavailable"); return true }
            }
            emit(["type": "space-result", "requestId": requestID, "status": "posted"])
            refresh(force: true)
            return true
        }
        guard let phaseName = value["phase"] as? String, let phase = DockSwipeEvent.Phase(rawValue: phaseName),
              let progress = number(value["progress"]), abs(progress) <= 1,
              let velocity = number(value["velocityX"]), abs(velocity) <= 100_000,
              phase == .changed || (phase == .ended ? abs(progress) == 1 : progress == 0 && velocity == 0)
        else { reject("malformed"); return true }
        if phase == .began {
            guard let display = currentDisplay() else { return true }
            cancel()
            gesture = (requestID, display)
        }
        // Changed frames reuse the begin snapshot. OS notifications invalidate it; do not
        // re-enumerate every Space and NSScreen at finger-sampling frequency.
        guard let current = gesture, current.id == requestID else { reject("not-owner"); return true }
        let nonzero = phase == .changed && progress == 0 ? Double(Float.leastNonzeroMagnitude) : progress
        guard frame(phase, nonzero, velocity, current.display) else {
            cancel(); reject("navigation-unavailable"); return true
        }
        if phase == .ended || phase == .cancelled { gesture = nil; refresh(force: true) }
        return true
    }

    private func frame(_ phase: DockSwipeEvent.Phase, _ progress: Double, _ velocity: Double,
                       _ display: DesktopDisplayRecord) -> Bool {
        guard let event = DockSwipeEvent.make(phase: phase, progress: progress, velocityX: velocity,
                                              location: CGPoint(x: display.bounds.midX, y: display.bounds.midY))
        else { return false }
        post(event)
        return true
    }

    private func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite else { return nil }
        return value.doubleValue
    }
}
