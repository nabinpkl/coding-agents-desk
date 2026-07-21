import BrowserProjection
import Foundation
import Testing

@testable import AgentDeskHost

@MainActor
struct BrowserProjectionViewportCoordinatorTests {
    @Test func lastClaimedActiveViewerOwnsAndReleaseFallsBack() throws {
        var sent: [BrowserProjectionSourceViewportCommand] = []
        let coordinator = BrowserProjectionViewportCoordinator { payload in
            if let command = try? JSONDecoder().decode(BrowserProjectionSourceViewportCommand.self, from: payload) {
                sent.append(command)
            }
            return true
        }
        coordinator.setBridgeConnected(true)
        coordinator.updateTarget(tabId: 9, generation: 3)
        coordinator.register(.local, profile: .desktop)
        let phone = BrowserProjectionViewportCoordinator.ViewerID.remote(.init("phone"))
        let tablet = BrowserProjectionViewportCoordinator.ViewerID.remote(.init("tablet"))
        coordinator.register(phone, profile: .mobile)
        coordinator.register(tablet, profile: .mobile)

        coordinator.update(viewer(active: true, claim: true, profile: .desktop, width: 1_000), from: .local)
        coordinator.update(viewer(active: true, claim: true, profile: .mobile, width: 390), from: phone)

        #expect(coordinator.status(for: phone)?.owner == true)
        #expect(coordinator.status(for: .local)?.owner == false)
        #expect(sent.last?.profile == .mobile)
        #expect(sent.last?.width == 390)

        coordinator.update(viewer(active: true, claim: true, profile: .mobile, width: 430), from: tablet)
        #expect(coordinator.status(for: tablet)?.owner == true)
        #expect(coordinator.status(for: phone)?.owner == false)
        #expect(sent.last?.width == 430)

        coordinator.update(viewer(active: false, claim: false, profile: .mobile, width: 430), from: tablet)
        #expect(coordinator.status(for: phone)?.owner == true)
        #expect(sent.last?.width == 390)

        coordinator.update(viewer(active: false, claim: false, profile: .mobile, width: 390), from: phone)
        #expect(coordinator.status(for: .local)?.owner == true)
        #expect(sent.last?.profile == .desktop)
        #expect(sent.last?.width == 1_000)
    }

    @Test func passiveResizeDoesNotStealOwnershipAndNoViewerRestoresNative() {
        var sent: [BrowserProjectionSourceViewportCommand] = []
        let coordinator = BrowserProjectionViewportCoordinator { payload in
            if let command = try? JSONDecoder().decode(BrowserProjectionSourceViewportCommand.self, from: payload) {
                sent.append(command)
            }
            return true
        }
        let phone = BrowserProjectionViewportCoordinator.ViewerID.remote(.init("phone"))
        coordinator.setBridgeConnected(true)
        coordinator.updateTarget(tabId: 7, generation: 2)
        coordinator.register(.local, profile: .desktop)
        coordinator.register(phone, profile: .mobile)
        coordinator.update(viewer(active: true, claim: true, profile: .mobile, width: 390), from: phone)
        coordinator.update(viewer(active: true, claim: false, profile: .desktop, width: 900), from: .local)

        #expect(coordinator.status(for: phone)?.owner == true)
        #expect(sent.last?.profile == .mobile)

        coordinator.update(viewer(active: false, claim: false, profile: .mobile, width: 390), from: phone)
        coordinator.update(viewer(active: false, claim: false, profile: .desktop, width: 900), from: .local)
        #expect(sent.last?.active == false)
        #expect(sent.last?.profile == nil)
    }

    @Test func presetsAreCanonicalRegardlessOfClientDimensions() {
        let coordinator = BrowserProjectionViewportCoordinator { _ in true }
        coordinator.register(.local, profile: .desktop)
        coordinator.update(
            BrowserProjectionViewerStateCommand(
                active: true, claim: true, profile: .desktop, sizing: .preset,
                width: 12, height: 13
            ),
            from: .local
        )
        #expect(coordinator.status(for: .local)?.width == 1_440)
        #expect(coordinator.status(for: .local)?.height == 900)
    }

    @Test func reconnectResendsLatestOwnerRequestAndReregisterRepublishesTargetedStatus() {
        var sent: [BrowserProjectionSourceViewportCommand] = []
        var statuses: [(BrowserProjectionViewportCoordinator.ViewerID, BrowserProjectionViewerStatus)] = []
        let coordinator = BrowserProjectionViewportCoordinator { payload in
            if let command = try? JSONDecoder().decode(BrowserProjectionSourceViewportCommand.self, from: payload) {
                sent.append(command)
            }
            return true
        }
        coordinator.onViewerStatus = { id, payload in
            if let status = try? JSONDecoder().decode(BrowserProjectionViewerStatus.self, from: payload) {
                statuses.append((id, status))
            }
        }
        let phone = BrowserProjectionViewportCoordinator.ViewerID.remote(.init("phone"))
        coordinator.register(phone, profile: .mobile)
        coordinator.updateTarget(tabId: 17, generation: 4)
        coordinator.setBridgeConnected(true)
        coordinator.update(viewer(active: true, claim: true, profile: .mobile, width: 390), from: phone)
        let connectedRevision = sent.last?.revision

        coordinator.setBridgeConnected(false)
        coordinator.update(viewer(active: true, claim: false, profile: .mobile, width: 412), from: phone)
        let disconnectedCount = sent.count
        coordinator.setBridgeConnected(true)

        #expect(sent.count == disconnectedCount + 1)
        #expect((sent.last?.revision ?? 0) > (connectedRevision ?? 0))
        #expect(sent.last?.tabId == 17)
        #expect(sent.last?.generation == 4)
        #expect(sent.last?.width == 412)

        let statusCount = statuses.count
        let sourceCount = sent.count
        coordinator.register(phone, profile: .mobile)
        #expect(statuses.count == statusCount + 1)
        #expect(sent.count == sourceCount + 1)
        #expect(statuses.last?.0 == phone)
        #expect(statuses.last?.1.owner == true)
    }

    @Test func nextOwnerClaimRetriesAnAppliedViewportError() {
        var sent: [BrowserProjectionSourceViewportCommand] = []
        let coordinator = BrowserProjectionViewportCoordinator { payload in
            if let command = try? JSONDecoder().decode(BrowserProjectionSourceViewportCommand.self, from: payload) {
                sent.append(command)
            }
            return true
        }
        coordinator.register(.local, profile: .desktop)
        coordinator.updateTarget(tabId: 8, generation: 2)
        coordinator.setBridgeConnected(true)
        let request = viewer(active: true, claim: true, profile: .desktop, width: 1_000)
        coordinator.update(request, from: .local)
        let countBeforeError = sent.count
        coordinator.updateAppliedViewport(BrowserProjectionViewportState(
            active: true,
            revision: sent.last?.revision ?? 0,
            profile: .desktop,
            sizing: .viewer,
            requestedWidth: 1_000,
            requestedHeight: 700,
            error: "debugger-detached"
        ))

        coordinator.update(request, from: .local)

        #expect(sent.count == countBeforeError + 1)
        #expect(sent.last?.width == 1_000)
    }

    private func viewer(
        active: Bool,
        claim: Bool,
        profile: BrowserProjectionViewportProfile,
        width: Int
    ) -> BrowserProjectionViewerStateCommand {
        BrowserProjectionViewerStateCommand(
            active: active,
            claim: claim,
            profile: profile,
            sizing: .viewer,
            width: width,
            height: 700
        )
    }
}
