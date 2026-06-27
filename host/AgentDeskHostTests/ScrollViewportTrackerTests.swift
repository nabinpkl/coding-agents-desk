import Foundation
import Testing

@testable import AgentDeskHost

struct ScrollViewportTrackerTests {
    @Test func locksOnlyInnerVerticalBodyAfterTwoValidatedFrames() throws {
        var tracker = ScrollViewportTracker(config: ScrollViewportConfig(
            minWidth: 64,
            minHeight: 64,
            confidenceThreshold: 0.88,
            minInsetPx: 16,
            overlapThreshold: 0.80
        ))
        let outer = ScrollRegion(
            x: 0,
            y: 0,
            width: 240,
            height: 180,
            source: .window(id: 1),
            stability: ScrollRegionStability(stableFrameCount: 2, overlapRatioWithPrevious: 1)
        )
        let viewport = TestRect(x: 48, y: 32, width: 160, height: 112)
        let previous = Self.surface(width: 240, height: 180) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = Self.surface(width: 240, height: 180) { x, y in
            if viewport.contains(x: x, y: y) {
                return y < viewport.maxY - 12
                    ? Self.pixel(x: x, y: y + 12)
                    : Self.exposedPixel(x: x, y: y)
            }
            return Self.pixel(x: x, y: y)
        }

        let maybeFirst = tracker.candidate(
            previous: previous,
            current: current,
            outerRegion: outer,
            offset: ScrollDeltaOffset(dx: 0, dy: -12)
        )
        let first = try #require(maybeFirst)
        #expect(tracker.observeValidation(candidate: first, accepted: true) == nil)

        let maybeSecond = tracker.candidate(
            previous: previous,
            current: current,
            outerRegion: outer,
            offset: ScrollDeltaOffset(dx: 0, dy: -12)
        )
        let second = try #require(maybeSecond)
        let maybeLocked = tracker.observeValidation(candidate: second, accepted: true)
        let locked = try #require(maybeLocked)

        #expect(locked.source == "derived-pixels")
        #expect(locked.x >= viewport.x - 16)
        #expect(locked.y >= viewport.y - 16)
        #expect(locked.maxX <= viewport.maxX + 16)
        #expect(locked.maxY <= viewport.maxY + 16)
        #expect(locked.width >= viewport.width - 16)
        #expect(locked.height >= viewport.height - 16)
        #expect(locked.outerRegion == outer)
    }

    @Test func rejectsWholeWindowMotionCandidate() throws {
        var tracker = ScrollViewportTracker(config: ScrollViewportConfig(
            minWidth: 64,
            minHeight: 64,
            confidenceThreshold: 0.88,
            minInsetPx: 16,
            overlapThreshold: 0.80
        ))
        let outer = ScrollRegion(
            x: 0,
            y: 0,
            width: 240,
            height: 180,
            source: .window(id: 2),
            stability: ScrollRegionStability(stableFrameCount: 2, overlapRatioWithPrevious: 1)
        )
        let previous = Self.surface(width: 240, height: 180) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = Self.surface(width: 240, height: 180) { x, y in
            y < 168 ? Self.pixel(x: x, y: y + 12) : Self.exposedPixel(x: x, y: y)
        }

        let candidate = tracker.candidate(
            previous: previous,
            current: current,
            outerRegion: outer,
            offset: ScrollDeltaOffset(dx: 0, dy: -12)
        )

        #expect(candidate == nil)
    }

    @Test func missReleasesStableViewport() throws {
        var tracker = ScrollViewportTracker(config: ScrollViewportConfig(
            minWidth: 64,
            minHeight: 64,
            confidenceThreshold: 0.88,
            minInsetPx: 16,
            overlapThreshold: 0.80
        ))
        let outer = ScrollRegion(
            x: 0,
            y: 0,
            width: 240,
            height: 180,
            source: .window(id: 3),
            stability: ScrollRegionStability(stableFrameCount: 2, overlapRatioWithPrevious: 1)
        )
        let viewport = TestRect(x: 48, y: 32, width: 160, height: 112)
        let previous = Self.surface(width: 240, height: 180) { x, y in Self.pixel(x: x, y: y) }
        let current = Self.surface(width: 240, height: 180) { x, y in
            viewport.contains(x: x, y: y) && y < viewport.maxY - 12
                ? Self.pixel(x: x, y: y + 12)
                : Self.pixel(x: x, y: y)
        }
        let maybeFirst = tracker.candidate(previous: previous, current: current, outerRegion: outer, offset: ScrollDeltaOffset(dx: 0, dy: -12))
        let first = try #require(maybeFirst)
        _ = tracker.observeValidation(candidate: first, accepted: true)
        let maybeSecond = tracker.candidate(previous: previous, current: current, outerRegion: outer, offset: ScrollDeltaOffset(dx: 0, dy: -12))
        let second = try #require(maybeSecond)
        _ = tracker.observeValidation(candidate: second, accepted: true)
        #expect(tracker.stableViewport != nil)

        #expect(tracker.observeValidation(candidate: nil, accepted: false) == nil)
        #expect(tracker.stableViewport != nil)
        #expect(tracker.observeValidation(candidate: nil, accepted: false) == nil)
        #expect(tracker.stableViewport == nil)
    }

    private static func surface(width: Int, height: Int, pixel: (Int, Int) -> [UInt8]) -> ScrollDeltaSurface {
        var data = Data(count: width * height * 4)
        data.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            for y in 0..<height {
                for x in 0..<width {
                    let bytes = pixel(x, y)
                    let offset = (y * width + x) * 4
                    base.storeBytes(of: bytes[0], toByteOffset: offset, as: UInt8.self)
                    base.storeBytes(of: bytes[1], toByteOffset: offset + 1, as: UInt8.self)
                    base.storeBytes(of: bytes[2], toByteOffset: offset + 2, as: UInt8.self)
                    base.storeBytes(of: bytes[3], toByteOffset: offset + 3, as: UInt8.self)
                }
            }
        }
        return ScrollDeltaSurface(width: width, height: height, bytesPerRow: width * 4, pixels: data)
    }

    private static func pixel(x: Int, y: Int) -> [UInt8] {
        [
            UInt8((x * 3) & 0xff),
            UInt8((y * 8) & 0xff),
            UInt8((x + y * 5) & 0xff),
            0xff
        ]
    }

    private static func exposedPixel(x: Int, y: Int) -> [UInt8] {
        [
            UInt8((200 + x) & 0xff),
            UInt8((150 + y) & 0xff),
            UInt8((100 + x + y) & 0xff),
            0xff
        ]
    }
}

private struct TestRect {
    let x: Int
    let y: Int
    let width: Int
    let height: Int

    var maxX: Int { x + width }
    var maxY: Int { y + height }

    func contains(x: Int, y: Int) -> Bool {
        x >= self.x && x < maxX && y >= self.y && y < maxY
    }
}
