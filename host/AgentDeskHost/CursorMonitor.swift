import AppKit
import CryptoKit
import Foundation
import os

// Samples the system cursor and emits a CursorImagePush whenever its
// shape changes, plus exposes the latest push so a freshly attached
// client can be seeded immediately.
//
// Runs a main-thread timer because NSCursor is a main-thread AppKit API.
// Each tick hashes the cursor's TIFF (cheap; cursors are tiny) and only
// PNG-encodes + broadcasts when the hash changes, so the steady-state
// cost is one small hash per tick.
//
// The sampler and interval are injectable so the change-detection logic
// can be unit-tested without a live window server.
final class CursorMonitor {
    // One sampled cursor. Abstracts NSCursor.currentSystem so tests can
    // feed fixed images.
    struct CursorSample {
        let image: NSImage
        let hotSpot: NSPoint
        let hidden: Bool
    }

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "cursor-monitor")
    private let interval: TimeInterval
    private let sampler: () -> CursorSample?
    private let positionSampler: () -> CGPoint?
    private var timer: DispatchSourceTimer?
    private var lastHash: String?
    private var lastPosition: CGPoint?

    // The most recent push, replayed to a client on attach so it gets the
    // current cursor without waiting for the next shape change.
    private(set) var latest: CursorImagePush?

    var onChange: ((CursorImagePush) -> Void)?
    var onPositionChange: ((CGPoint) -> Void)?
    var shouldEmitPosition: () -> Bool = { true }

    init(
        interval: TimeInterval = 0.05,
        sampler: @escaping () -> CursorSample? = CursorMonitor.systemSampler,
        positionSampler: @escaping () -> CGPoint? = CursorMonitor.systemPositionSampler
    ) {
        self.interval = interval
        self.sampler = sampler
        self.positionSampler = positionSampler
    }

    // Reads the system-wide cursor. `currentSystem` reflects whatever app
    // set the cursor (Safari, a terminal, a design tool); it can be nil in
    // some secure contexts, so fall back to the in-process `current`.
    static func systemSampler() -> CursorSample? {
        let cursor = NSCursor.currentSystem ?? NSCursor.current
        return CursorSample(image: cursor.image, hotSpot: cursor.hotSpot, hidden: false)
    }

    static func systemPositionSampler() -> CGPoint? {
        CGEvent(source: nil)?.location
    }

    func start() {
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now(), repeating: interval)
        source.setEventHandler { [weak self] in self?.tick() }
        timer = source
        source.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    // Exposed for tests: run one detection cycle and return the push if the
    // cursor changed since the last cycle, else nil.
    @discardableResult
    func tick() -> CursorImagePush? {
        tickPosition()
        guard let sample = sampler() else { return nil }
        guard let tiff = sample.image.tiffRepresentation else { return nil }
        let hash = Self.hash(tiff)
        guard hash != lastHash else { return nil }
        guard let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            logger.error("cursor PNG encode failed")
            return nil
        }
        lastHash = hash
        let size = sample.image.size
        let w = Float(size.width)
        let h = Float(size.height)
        let push = CursorImagePush(
            hash: hash,
            png: png.base64EncodedString(),
            hotspotXFrac: w > 0 ? Float(sample.hotSpot.x) / w : 0,
            hotspotYFrac: h > 0 ? Float(sample.hotSpot.y) / h : 0,
            widthPoints: w,
            heightPoints: h,
            hidden: sample.hidden
        )
        latest = push
        onChange?(push)
        return push
    }

    @discardableResult
    private func tickPosition() -> CGPoint? {
        guard shouldEmitPosition(), let position = positionSampler() else { return nil }
        guard position != lastPosition else { return nil }
        lastPosition = position
        onPositionChange?(position)
        return position
    }

    private static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
