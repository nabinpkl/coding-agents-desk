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
}
