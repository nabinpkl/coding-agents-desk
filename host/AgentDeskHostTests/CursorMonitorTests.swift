import AppKit
import Foundation
import Testing

@testable import AgentDeskHost

// Scriptable cursor seed for tests: the monitor reads currentSeed() each tick, so tests
// bump `seed` to simulate a window-server cursor change.
final class FakeCursorChangeSignal: CursorChangeSignal, @unchecked Sendable {
    var seed: UInt64
    init(_ seed: UInt64 = 0) { self.seed = seed }
    func currentSeed() -> UInt64 { seed }
}

// CursorMonitor's job is change-detection: emit a push only when the cursor image actually
// changes. Detection is now gated on the cursor seed (cheap) and only fingerprints
// (encode + hash) on a seed change or the heartbeat backstop. These tests drive it with an
// injected sampler + fake seed + fixed clock so they run without a live window server.
struct CursorMonitorTests {
    // Builds a deterministic opaque bitmap image. Distinct `value` bytes
    // produce distinct TIFF data, hence distinct content hashes.
    private func makeImage(width: Int, height: Int, value: UInt8) -> NSImage {
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width,
            pixelsHigh: height,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: width * 4,
            bitsPerPixel: 32
        )!
        if let data = rep.bitmapData {
            memset(data, Int32(value), width * height * 4)
        }
        let image = NSImage(size: NSSize(width: width, height: height))
        image.addRepresentation(rep)
        return image
    }

    @Test func emitsOnceUntilTheCursorChanges() {
        let imageA = makeImage(width: 10, height: 20, value: 0x40)
        var current = CursorMonitor.CursorSample(
            image: imageA,
            hotSpot: NSPoint(x: 2, y: 4),
            hidden: false
        )
        let signal = FakeCursorChangeSignal(1)
        let monitor = CursorMonitor(
            sampler: { current },
            positionSampler: { nil },
            changeSignal: signal,
            now: { 0 }
        )

        // First tick establishes the baseline (seed change from nil).
        let first = monitor.tick()
        #expect(first != nil)
        #expect(monitor.latest == first)

        // Same seed: gated out even if we swapped the image, no emit.
        current = CursorMonitor.CursorSample(
            image: makeImage(width: 10, height: 20, value: 0x80),
            hotSpot: NSPoint(x: 2, y: 4),
            hidden: false
        )
        #expect(monitor.tick() == nil)

        // Seed bumps (window server changed the cursor): re-fingerprint, different hash.
        signal.seed = 2
        let second = monitor.tick()
        #expect(second != nil)
        #expect(second?.hash != first?.hash)
    }

    // The CPU-fix regression lock: a static cursor (seed unchanged) must NOT fingerprint.
    // With the seed held constant and the heartbeat disabled, the sampler is touched exactly
    // once (the baseline) across many ticks, not once per tick.
    @Test func constantSeedSkipsImageFingerprint() {
        let sample = CursorMonitor.CursorSample(
            image: makeImage(width: 10, height: 20, value: 0x40),
            hotSpot: NSPoint(x: 0, y: 0),
            hidden: false
        )
        var samplerCalls = 0
        let signal = FakeCursorChangeSignal(7)
        let monitor = CursorMonitor(
            sampler: { samplerCalls += 1; return sample },
            positionSampler: { nil },
            changeSignal: signal,
            heartbeatMs: 0,   // disable the heartbeat so only the seed can trigger work
            now: { 0 }
        )
        var pushes = 0
        monitor.onChange = { _ in pushes += 1 }

        for _ in 0..<100 { monitor.tick() }

        #expect(samplerCalls == 1)
        #expect(pushes == 1)
    }

    // A seed bump with identical pixels must not emit a spurious push (hash dedup), and the
    // same image yields the same content hash regardless of seed (client cache key stable).
    @Test func seedBumpWithSamePixelsDoesNotEmitAndHashIsStable() {
        let sample = CursorMonitor.CursorSample(
            image: makeImage(width: 8, height: 8, value: 0x33),
            hotSpot: NSPoint(x: 0, y: 0),
            hidden: false
        )
        let signal = FakeCursorChangeSignal(1)
        let monitor = CursorMonitor(
            sampler: { sample },
            positionSampler: { nil },
            changeSignal: signal,
            now: { 0 }
        )
        let first = monitor.tick()
        #expect(first != nil)
        // Seed moved but the image is identical: no emit.
        signal.seed = 2
        #expect(monitor.tick() == nil)

        // A fresh monitor fed the same image produces the same hash (stable cache key).
        let other = CursorMonitor(
            sampler: { sample }, positionSampler: { nil },
            changeSignal: FakeCursorChangeSignal(99), now: { 0 }
        )
        #expect(other.tick()?.hash == first?.hash)
    }

    // Backstop: if the seed never moves (e.g. the private symbol is unavailable and returns
    // a sentinel), the heartbeat still forces a re-fingerprint so a real change is caught.
    @Test func heartbeatForcesRefingerprintWhenSeedStuck() {
        var current = CursorMonitor.CursorSample(
            image: makeImage(width: 10, height: 10, value: 0x10),
            hotSpot: NSPoint(x: 0, y: 0),
            hidden: false
        )
        var clock: UInt64 = 0
        let monitor = CursorMonitor(
            sampler: { current },
            positionSampler: { nil },
            changeSignal: FakeCursorChangeSignal(5),   // constant seed, never moves
            heartbeatMs: 2_000,
            now: { clock }
        )
        let first = monitor.tick()
        #expect(first != nil)

        // Seed still 5; before the heartbeat elapses a changed image is NOT picked up.
        current = CursorMonitor.CursorSample(
            image: makeImage(width: 10, height: 10, value: 0x90),
            hotSpot: NSPoint(x: 0, y: 0),
            hidden: false
        )
        #expect(monitor.tick() == nil)

        // Advance past the heartbeat: the re-fingerprint fires despite the stuck seed.
        clock = 2_000 * 1_000_000
        let healed = monitor.tick()
        #expect(healed != nil)
        #expect(healed?.hash != first?.hash)
    }

    @Test func hotspotIsExpressedAsImageFractions() {
        let sample = CursorMonitor.CursorSample(
            image: makeImage(width: 10, height: 20, value: 0x40),
            hotSpot: NSPoint(x: 2, y: 4),
            hidden: false
        )
        let monitor = CursorMonitor(sampler: { sample }, positionSampler: { nil })
        let push = monitor.tick()
        #expect(push != nil)
        #expect(abs((push?.hotspotXFrac ?? 0) - 0.2) < 0.0001)
        #expect(abs((push?.hotspotYFrac ?? 0) - 0.2) < 0.0001)
        #expect(push?.widthPoints == 10)
        #expect(push?.heightPoints == 20)
        #expect(push?.png != nil)
    }

    @Test func pushRoundTripsThroughJSON() throws {
        let push = CursorImagePush(
            hash: "abc123",
            png: "Zm9v",
            hotspotXFrac: 0.5,
            hotspotYFrac: 0.25,
            widthPoints: 16,
            heightPoints: 24,
            hidden: false
        )
        let data = try JSONEncoder().encode(push)
        // The discriminator the client dispatches on must be present.
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(object?["t"] as? String == "cursor")
        let decoded = try JSONDecoder().decode(CursorImagePush.self, from: data)
        #expect(decoded == push)
    }

    @Test func positionChangesEmitOnlyWhenAllowed() {
        let sample = CursorMonitor.CursorSample(
            image: makeImage(width: 10, height: 20, value: 0x40),
            hotSpot: NSPoint(x: 0, y: 0),
            hidden: false
        )
        var point = CGPoint(x: 10, y: 20)
        let monitor = CursorMonitor(
            sampler: { sample },
            positionSampler: { point }
        )
        var emitted: [CGPoint] = []
        monitor.onPositionChange = { emitted.append($0) }

        monitor.tick()
        monitor.tick()
        #expect(emitted == [CGPoint(x: 10, y: 20)])

        monitor.shouldEmitPosition = { false }
        point = CGPoint(x: 30, y: 40)
        monitor.tick()
        #expect(emitted == [CGPoint(x: 10, y: 20)])

        monitor.shouldEmitPosition = { true }
        monitor.tick()
        #expect(emitted == [CGPoint(x: 10, y: 20), CGPoint(x: 30, y: 40)])
    }
}
