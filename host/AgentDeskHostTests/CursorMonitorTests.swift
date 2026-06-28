import AppKit
import Foundation
import Testing

@testable import AgentDeskHost

// CursorMonitor's job is change-detection: emit a push only when the
// cursor image actually changes, with the hotspot expressed as fractions
// of the image. These tests drive it with an injected sampler so they run
// without a live window server.
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
        let monitor = CursorMonitor(sampler: { current }, positionSampler: { nil })

        // First sample is a change from nothing.
        let first = monitor.tick()
        #expect(first != nil)
        #expect(monitor.latest == first)

        // Same image: no emit.
        #expect(monitor.tick() == nil)

        // New image: emit again with a different hash.
        current = CursorMonitor.CursorSample(
            image: makeImage(width: 10, height: 20, value: 0x80),
            hotSpot: NSPoint(x: 2, y: 4),
            hidden: false
        )
        let second = monitor.tick()
        #expect(second != nil)
        #expect(second?.hash != first?.hash)
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
