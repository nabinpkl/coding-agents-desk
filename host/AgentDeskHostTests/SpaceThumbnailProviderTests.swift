import Foundation
import Testing

@MainActor
struct SpaceThumbnailProviderTests {
    @Test func ownerDemandKeepsProviderEnabledUntilLastOwnerClears() {
        let provider = SpaceThumbnailProvider(skylight: nil)

        provider.setDemand(owner: .client("phone-a"), enabled: true)
        #expect(provider.hasActiveDemand)

        provider.setDemand(owner: .spaceAgent, enabled: true)
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
}
