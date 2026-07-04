import AppKit
import CryptoKit
import Foundation
import os

// Samples the system cursor and emits a CursorImagePush whenever its
// shape changes, plus exposes the latest push so a freshly attached
// client can be seeded immediately.
//
// Runs a main-thread timer because NSCursor is a main-thread AppKit API.
// Change detection is gated on the window-server cursor seed (CursorChangeSignal):
// a static cursor costs one integer read per tick, and only a seed change (or the
// periodic heartbeat backstop) triggers the expensive image fetch + PNG encode + hash.
// This is the TeamViewer/AnyDesk pattern; re-encoding + hashing the cursor image every
// tick to detect change is what made this a steady CPU eater.
//
// The sampler, interval, change signal, and clock are injectable so the detection logic
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
    private let changeSignal: CursorChangeSignal
    private let now: () -> UInt64
    private let heartbeatNs: UInt64
    private var timer: DispatchSourceTimer?
    private var lastHash: String?
    private var lastPosition: CGPoint?
    // Cursor seed at the last fingerprint; nil until the first tick establishes a baseline.
    private var lastSeed: UInt64?
    // Uptime of the last actual fingerprint, for the heartbeat backstop. 0 forces the first
    // tick to fingerprint regardless of the seed.
    private var lastFingerprintNs: UInt64 = 0

    // The most recent push, replayed to a client on attach so it gets the
    // current cursor without waiting for the next shape change.
    private(set) var latest: CursorImagePush?

    var onChange: ((CursorImagePush) -> Void)?
    var onPositionChange: ((CGPoint) -> Void)?
    var shouldEmitPosition: () -> Bool = { true }

    init(
        interval: TimeInterval = 0.05,
        sampler: @escaping () -> CursorSample? = CursorMonitor.systemSampler,
        positionSampler: @escaping () -> CGPoint? = CursorMonitor.systemPositionSampler,
        changeSignal: CursorChangeSignal = SystemCursorChangeSignal(),
        heartbeatMs: Int = Config.cursorImageHeartbeatMs,
        now: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }
    ) {
        self.interval = interval
        self.sampler = sampler
        self.positionSampler = positionSampler
        self.changeSignal = changeSignal
        self.heartbeatNs = UInt64(max(0, heartbeatMs)) * 1_000_000
        self.now = now
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
        // Cheap gate: read the window-server cursor seed. Skip the whole fetch/encode/hash
        // unless the seed moved (cursor changed) or the heartbeat backstop is due. This is
        // the steady-state fast path -- one integer read while the cursor is unchanged.
        let seed = changeSignal.currentSeed()
        let nowNs = now()
        let heartbeatDue = heartbeatNs > 0 && nowNs &- lastFingerprintNs >= heartbeatNs
        guard seed != lastSeed || heartbeatDue else { return nil }
        lastSeed = seed
        lastFingerprintNs = nowNs
        guard let sample = sampler() else { return nil }
        // Encode the PNG once (the bytes actually sent) and hash that for the wire cache key
        // and local dedup. A seed bump or heartbeat that did not actually change the pixels
        // hits the hash guard below and emits nothing.
        guard let tiff = sample.image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            logger.error("cursor PNG encode failed")
            return nil
        }
        let hash = Self.hash(png)
        guard hash != lastHash else { return nil }
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
