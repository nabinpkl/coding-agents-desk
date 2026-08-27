import AppKit
import CoreGraphics
import Foundation

/// The macOS-only sampling seam for the TypeScript-owned desktop cursor mirror.
///
/// The steady-state path reads one WindowServer integer every 50 ms. Cursor pixels are
/// fetched and PNG-encoded only when that seed changes, with a 2-second fingerprint
/// heartbeat as a bounded recovery path if the private seed ever stops resolving. Position
/// sampling rides the same tick, but is suppressed while remote input owns the pointer so a
/// delayed observation cannot fight the browser's zero-latency prediction.
final class CursorMirror: @unchecked Sendable {
    private let bounds: CGRect
    private let remoteInputIsActive: () -> Bool
    private let emit: (Data) -> Void
    private let seed = CursorSeedSignal()
    private var timer: DispatchSourceTimer?
    private var lastSeed: UInt64?
    private var lastFingerprintNs: UInt64 = 0
    private var lastPosition: CGPoint?

    private static let intervalMs = 50
    private static let heartbeatNs: UInt64 = 2_000_000_000

    init(
        bounds: CGRect,
        remoteInputIsActive: @escaping () -> Bool,
        emit: @escaping (Data) -> Void
    ) {
        self.bounds = bounds
        self.remoteInputIsActive = remoteInputIsActive
        self.emit = emit
    }

    static func sourceLocalPosition(in bounds: CGRect) -> CGPoint? {
        guard bounds.width > 0,
              bounds.height > 0,
              let raw = CGEvent(source: nil)?.location else { return nil }
        return CGPoint(
            x: min(max(bounds.minX, raw.x), bounds.maxX - 1) - bounds.minX,
            y: min(max(bounds.minY, raw.y), bounds.maxY - 1) - bounds.minY
        )
    }

    func start() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(
            deadline: .now(),
            repeating: .milliseconds(Self.intervalMs),
            leeway: .milliseconds(5)
        )
        source.setEventHandler { [weak self] in self?.tick() }
        timer = source
        source.resume()
    }

    private func tick() {
        tickPosition()

        let currentSeed = seed.current()
        let now = DispatchTime.now().uptimeNanoseconds
        let heartbeatDue = now &- lastFingerprintNs >= Self.heartbeatNs
        guard currentSeed != lastSeed || heartbeatDue else { return }
        lastSeed = currentSeed
        lastFingerprintNs = now
        emitCursorImage()
    }

    private func tickPosition() {
        guard let position = Self.sourceLocalPosition(in: bounds),
              position != lastPosition else { return }
        lastPosition = position
        guard !remoteInputIsActive() else { return }
        emitJSON([
            "type": "cursor-position",
            "x": position.x,
            "y": position.y,
        ])
    }

    private func emitCursorImage() {
        let cursor = NSCursor.currentSystem ?? NSCursor.current
        guard let tiff = cursor.image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write(Data("grid-encoder: cursor PNG encode failed\n".utf8))
            return
        }
        let size = cursor.image.size
        emitJSON([
            "type": "cursor-image",
            "png": png.base64EncodedString(),
            "hotspotXFrac": size.width > 0 ? cursor.hotSpot.x / size.width : 0,
            "hotspotYFrac": size.height > 0 ? cursor.hotSpot.y / size.height : 0,
            "widthPoints": size.width,
            "heightPoints": size.height,
            "hidden": false,
            "cursorKind": CursorClassifier.kind(cursor),
        ])
    }

    private func emitJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else {
            FileHandle.standardError.write(Data("grid-encoder: cursor event encode failed\n".utf8))
            return
        }
        emit(data)
    }
}

enum CursorClassifier {
    static func currentKind() -> String {
        kind(NSCursor.currentSystem ?? NSCursor.current)
    }

    static func kind(_ cursor: NSCursor) -> String {
        if matches(cursor, NSCursor.arrow) { return "arrow" }
        if matches(cursor, NSCursor.iBeam) || matches(cursor, NSCursor.iBeamCursorForVerticalLayout) {
            return "ibeam"
        }
        if matches(cursor, NSCursor.pointingHand) { return "pointingHand" }
        let resize = [
            NSCursor.resizeLeftRight,
            NSCursor.resizeUpDown,
            NSCursor.resizeLeft,
            NSCursor.resizeRight,
            NSCursor.resizeUp,
            NSCursor.resizeDown,
        ]
        if resize.contains(where: { matches(cursor, $0) }) { return "resize" }
        return "unknown"
    }

    private static func matches(_ cursor: NSCursor, _ candidate: NSCursor) -> Bool {
        if cursor === candidate { return true }
        guard cursor.hotSpot == candidate.hotSpot,
              let cursorData = cursor.image.tiffRepresentation,
              let candidateData = candidate.image.tiffRepresentation else { return false }
        return cursorData == candidateData
    }
}

/// Private WindowServer seed isolated to the helper's one cheap change-detection call.
private struct CursorSeedSignal: @unchecked Sendable {
    typealias CurrentCursorSeed = @convention(c) () -> Int32

    private static let function: CurrentCursorSeed? = {
        let path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
        guard let handle = dlopen(path, RTLD_NOW),
              let symbol = dlsym(handle, "SLSCurrentCursorSeed")
                ?? dlsym(handle, "CGSCurrentCursorSeed") else {
            FileHandle.standardError.write(Data(
                "grid-encoder: cursor seed unavailable; using 2s fingerprint heartbeat\n".utf8
            ))
            return nil
        }
        return unsafeBitCast(symbol, to: CurrentCursorSeed.self)
    }()

    func current() -> UInt64 {
        guard let function = Self.function else { return 0 }
        return UInt64(UInt32(bitPattern: function()))
    }
}
