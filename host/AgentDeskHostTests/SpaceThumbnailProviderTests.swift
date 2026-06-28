import CoreGraphics
import Foundation
import os
import Testing

@MainActor
struct SpaceThumbnailProviderTests {
    @Test func ownerDemandKeepsProviderEnabledUntilLastOwnerClears() {
        let provider = SpaceThumbnailProvider(skylight: nil)

        provider.setDemand(owner: .client("phone-a"), enabled: true)
        #expect(provider.hasActiveDemand)

        provider.setDemand(owner: SpaceThumbnailDemandOwner.spaceAgent, enabled: true)
        provider.setDemand(owner: .client("phone-a"), enabled: false)
        #expect(provider.hasActiveDemand)

        provider.setDemand(owner: .spaceAgent, enabled: false)
        #expect(!provider.hasActiveDemand)
    }

    @Test func cachedSnapshotSurvivesDemandDisableAndFeedsNextSubscriber() async {
        let thumbnail = Data([1, 2, 3])
        let topWindow = SpaceTopWindow(title: "agent-desk", appName: "Code")
        let provider = SpaceThumbnailProvider(
            skylight: nil,
            captureOverride: {
                SpaceThumbnailProvider.CaptureResult(
                    thumbnails: [10: thumbnail],
                    topWindows: [10: topWindow]
                )
            }
        )
        let firstStream = provider.thumbnails
        let firstValue = Task {
            var iterator = firstStream.makeAsyncIterator()
            return await iterator.next()
        }

        provider.setDemand(owner: .spaceAgent, enabled: true)

        #expect(await firstValue.value == [10: thumbnail])
        #expect(provider.latestTopWindows == [10: topWindow])

        provider.setDemand(owner: .spaceAgent, enabled: false)
        #expect(!provider.hasActiveDemand)
        #expect(provider.latestTopWindows == [10: topWindow])

        let secondStream = provider.thumbnails
        var secondIterator = secondStream.makeAsyncIterator()
        #expect(await secondIterator.next() == [10: thumbnail])
    }

    @Test func failedCaptureKeepsCachedSnapshot() async {
        let thumbnail = Data([1, 2, 3])
        let calls = OSAllocatedUnfairLock<Int>(initialState: 0)
        let provider = SpaceThumbnailProvider(
            skylight: nil,
            captureOverride: {
                let next = calls.withLock { value -> Int in
                    value += 1
                    return value
                }
                if next == 1 {
                    return SpaceThumbnailProvider.CaptureResult(
                        thumbnails: [10: thumbnail],
                        topWindows: [:]
                    )
                }
                return .failure("simulated")
            }
        )
        let stream = provider.thumbnails
        var iterator = stream.makeAsyncIterator()

        provider.setDemand(owner: .spaceAgent, enabled: true)
        #expect(await iterator.next() == [10: thumbnail])

        provider.forceRefresh()
        #expect(await iterator.next() == [10: thumbnail])
    }

    @Test func blackCaptureImagesAreRejectedAsBlank() throws {
        let black = try #require(makeImage(fill: CGColor(red: 0, green: 0, blue: 0, alpha: 1)))
        let visible = try #require(makeImage(fill: CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1)))

        #expect(SpaceThumbnailProvider.imageIsProbablyBlank(black))
        #expect(!SpaceThumbnailProvider.imageIsProbablyBlank(visible))
    }

    private func makeImage(fill: CGColor) -> CGImage? {
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(
                data: nil,
                width: 16,
                height: 16,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return nil }
        ctx.setFillColor(fill)
        ctx.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        return ctx.makeImage()
    }
}
